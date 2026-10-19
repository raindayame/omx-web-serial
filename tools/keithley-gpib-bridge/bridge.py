#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Keithley 2400 GPIB bridge for OMX Web Serial.

背景：瀏覽器的 Web Serial API 看不到 NI GPIB-USB-HS（它是 NI-VISA 裝置，
不會變成 COM 埠），所以網頁無法直連。這支跑在本機的小程式經 PyVISA +
NI-VISA 驅動 GPIB，再用 WebSocket 把 SCPI 指令／回應轉給網頁。

需求：
  - NI-VISA driver（已裝：原本 Qt 版就是用它走 GPIB）
  - pip install pyvisa websockets

用法：
  python bridge.py               # 監聽 ws://127.0.0.1:8765
  python bridge.py --port 8765

協定（WebSocket 文字框，JSON；control 訊息可帶 rpc id，bridge 會原樣帶回）：
  -> {"type":"hello"}                        <- {"type":"hello","ok":true}
  -> {"type":"list"}                         <- {"type":"resources","items":[...]}
  -> {"type":"open","resource":"GPIB0::24::INSTR"}
                                             <- {"type":"opened","resource":...}
  -> {"type":"line","cmd":"*IDN?"}           <- {"type":"data","line":"KEITHLEY INSTRUMENTS INC.,MODEL 2400,..."}
  -> {"type":"line","cmd":":OUTP ON"}        <- {"type":"ack"}
  -> {"type":"close"}                        <- {"type":"closed"}
  錯誤一律：{"type":"error","message":"..."}
"""

import argparse
import asyncio
import json
import sys

try:
    import pyvisa
except ImportError:
    sys.exit("需要 pyvisa：pip install pyvisa（另需 NI-VISA 驅動程式）")

try:
    from websockets.asyncio.server import serve  # websockets >= 13
    _WS_NEW_API = True
except ImportError:
    try:
        import websockets  # 舊版 API
        _WS_NEW_API = False
    except ImportError:
        sys.exit("需要 websockets：pip install websockets")

HOST = "127.0.0.1"

rm = pyvisa.ResourceManager()
inst = None
inst_lock = asyncio.Lock()


async def send(ws, obj):
    await ws.send(json.dumps(obj, ensure_ascii=False))


async def handle(ws, path=None):
    global inst
    peer = getattr(ws, "remote_address", "?")
    print(f"[bridge] 連線：{peer}", flush=True)
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            rpc = msg.get("rpc")
            t = msg.get("type")

            async def reply(obj):
                if rpc is not None:
                    obj["rpc"] = rpc
                await send(ws, obj)

            try:
                if t == "hello":
                    await reply({"type": "hello", "ok": True})
                elif t == "list":
                    await reply({"type": "resources",
                                 "items": list(rm.list_resources())})
                elif t == "open":
                    res = (msg.get("resource") or "").strip()
                    if not res:
                        raise ValueError("未指定 resource")
                    async with inst_lock:
                        if inst is not None:
                            try:
                                inst.close()
                            except Exception:
                                pass
                            inst = None
                        inst = rm.open_resource(res)
                        inst.timeout = 5000
                        inst.read_termination = "\n"
                        inst.write_termination = "\n"
                    print(f"[bridge] 開啟：{res}", flush=True)
                    await reply({"type": "opened", "resource": res})
                elif t == "line":
                    cmd = (msg.get("cmd") or "").strip()
                    if inst is None:
                        raise RuntimeError("GPIB 尚未 open，請先送 open")
                    async with inst_lock:
                        if cmd.endswith("?"):
                            line = await asyncio.to_thread(inst.query, cmd)
                            await send(ws, {"type": "data",
                                            "line": line.strip()})
                        else:
                            await asyncio.to_thread(inst.write, cmd)
                            await send(ws, {"type": "ack"})
                elif t == "close":
                    async with inst_lock:
                        if inst is not None:
                            try:
                                inst.close()
                            except Exception:
                                pass
                            inst = None
                    print("[bridge] 關閉儀器", flush=True)
                    await reply({"type": "closed"})
                else:
                    await reply({"type": "error",
                                 "message": f"未知 type：{t}"})
            except Exception as e:
                await reply({"type": "error",
                             "message": f"{type(e).__name__}: {e}"})
    finally:
        print(f"[bridge] 斷線：{peer}", flush=True)


async def amain(port):
    try:
        resources = list(rm.list_resources())
    except Exception as e:
        resources = [f"<列舉失敗：{e}>"]
    print(f"[bridge] VISA resources: {resources}", flush=True)
    print(f"[bridge] 監聽 ws://{HOST}:{port}（Ctrl+C 結束）", flush=True)
    if _WS_NEW_API:
        async with serve(handle, HOST, port):
            await asyncio.Future()
    else:
        async with websockets.serve(handle, HOST, port):
            await asyncio.Future()


def main():
    ap = argparse.ArgumentParser(description="Keithley 2400 GPIB bridge")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    try:
        asyncio.run(amain(args.port))
    except KeyboardInterrupt:
        print("\n[bridge] 結束", flush=True)


if __name__ == "__main__":
    main()
