#!/usr/bin/env python3
"""Ollama 本地模型基线实测（M0）。

对每个指定模型测量：digest、加载时间、TTFT、tokens/s、峰值 VRAM 增量。
用法: python ollama-bench.py qwen3:0.6b [更多模型...] [--out results/ollama-baseline.json]
"""
import json
import subprocess
import sys
import time
import urllib.request

OLLAMA = "http://localhost:11434"
PROMPT = "用三句话解释什么是数据库的事务隔离级别。"


def api(path, payload=None, timeout=600):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(OLLAMA + path, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def vram_used_mib():
    out = subprocess.check_output(
        ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
        text=True)
    return int(out.strip().splitlines()[0])


def bench(model):
    rec = {"model": model}
    show = api("/api/show", {"model": model})
    rec["digest"] = show.get("details", {}).get("quantization_level", "?")
    rec["model_info"] = {k: v for k, v in show.items() if k in ("parameters", "template")} or None
    info = api("/api/show", {"model": model, "verbose": True}).get("model_info", {})
    rec["context_length"] = next((v for k, v in info.items() if k.endswith("context_length")), None)

    base_vram = vram_used_mib()
    t0 = time.monotonic()
    # 加载计时：keep_alive 预热请求（空 prompt）
    api("/api/generate", {"model": model, "prompt": "", "keep_alive": "10m",
                          "options": {"num_predict": 1}})
    rec["load_seconds"] = round(time.monotonic() - t0, 2)
    rec["vram_after_load_mib"] = vram_used_mib() - base_vram

    t0 = time.monotonic()
    first_token_at = None
    tokens = 0
    req = urllib.request.Request(
        OLLAMA + "/api/generate",
        data=json.dumps({"model": model, "prompt": PROMPT, "keep_alive": "10m",
                         "options": {"num_predict": 256}}).encode(),
        headers={"Content-Type": "application/json"})
    final = {}
    with urllib.request.urlopen(req, timeout=600) as r:
        for line in r:
            chunk = json.loads(line.decode())
            if first_token_at is None and chunk.get("response"):
                first_token_at = time.monotonic()
            if chunk.get("done"):
                final = chunk
    rec["ttft_seconds"] = round((first_token_at or t0) - t0, 3)
    eval_count = final.get("eval_count", 0)
    eval_ns = final.get("eval_duration", 1)
    rec["eval_tokens"] = eval_count
    rec["tokens_per_second"] = round(eval_count / (eval_ns / 1e9), 2) if eval_ns else None
    rec["total_seconds"] = round(time.monotonic() - t0, 2)
    rec["vram_peak_delta_mib"] = vram_used_mib() - base_vram
    api("/api/generate", {"model": model, "prompt": "", "keep_alive": 0})  # 卸载
    return rec


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = None
    if "--out" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1]
    results = []
    for m in args:
        print(f"[bench] {m} ...", flush=True)
        try:
            rec = bench(m)
        except Exception as exc:
            rec = {"model": m, "error": f"{type(exc).__name__}: {exc}"}
        print(json.dumps(rec, ensure_ascii=False), flush=True)
        results.append(rec)
    doc = {"date": time.strftime("%Y-%m-%d"), "gpu": "RTX 5090 Laptop 24GB",
           "ollama": subprocess.check_output(["ollama", "--version"], text=True).strip(),
           "results": results}
    text = json.dumps(doc, ensure_ascii=False, indent=2)
    if out:
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
        print("saved:", out)
    else:
        print(text)


if __name__ == "__main__":
    main()
