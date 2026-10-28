#!/usr/bin/env python3
"""build_index.py —— 把公开种子聚合成 dist/ 索引

输入（只读）：memories/*.json（跳过 template.json）
输出：
    dist/memories.json         { schema_version, license, count, memories: [...] }
    dist/memories.array.json   纯数组，方便 raw 直接 fetch

三条硬规则：
1. **只读 memories/**。本脚本没有任何指向本地私有目录（~/.dsh/data/...）的代码路径，
   也不接受外部传入的目录参数 —— 想聚合别的东西，请改代码并过 review。
2. 输出必须是**幂等**的：不写时间戳、不写命令参数、不依赖文件系统遍历顺序。
   同一份输入跑两次必须逐字节相同，否则 CI 的「有 diff 才提交」会天天误报。
3. 坏数据直接失败退出，绝不把半截数据写进 dist/。聚合前会先跑一遍
   `scripts/check_memory.py`（长度、隐私、id 查重都在那边），校验不过就退出。

用法：
    python scripts/build_index.py
    python scripts/build_index.py --out dist
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
MEMORIES_DIR = ROOT / "memories"
DEFAULT_OUT = ROOT / "dist"
SCHEMA_VERSION = "1.0.0"
LICENSE = "CC0-1.0"

REQUIRED_FIELDS = (
    "id",
    "fish_name",
    "contributor",
    "title",
    "content",
    "tags",
    "memory_type",
    "license",
    "created_at",
)


def die(message: str) -> None:
    print(f"[FATAL] {message}", file=sys.stderr)
    raise SystemExit(1)


def ensure_valid() -> None:
    """先跑 check_memory.py，校验不过就不聚合。

    这个脚本自己只查字段完整性，不查长度和隐私。少了这一步，
    `python scripts/build_index.py` 会把一条 6 个字的坏记忆写进 dist/。
    """
    script = ROOT / "scripts" / "check_memory.py"
    if not script.exists():
        return
    result = subprocess.run(
        [sys.executable, str(script)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        print(result.stdout.rstrip())
        if result.stderr.strip():
            print(result.stderr.rstrip(), file=sys.stderr)
        die("公开记忆校验未通过，拒绝聚合。先修上面的错误再重跑。")


def load_memories() -> list[dict[str, Any]]:
    if not MEMORIES_DIR.exists():
        die(f"找不到公开记忆目录：{MEMORIES_DIR}")

    files = sorted(path for path in MEMORIES_DIR.glob("*.json") if path.name != "template.json")
    memories: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for path in files:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            die(f"{path.name} JSON 解析失败：{error.msg}（第 {error.lineno} 行）")

        if not isinstance(payload, dict):
            die(f"{path.name} 顶层必须是对象")

        missing = [field for field in REQUIRED_FIELDS if field not in payload]
        if missing:
            die(f"{path.name} 缺少字段：{', '.join(missing)}（先跑 python scripts/check_memory.py）")

        memory_id = payload["id"]
        if memory_id in seen_ids:
            die(f"{path.name} 的 id {memory_id} 重复（先跑 python scripts/check_memory.py）")
        seen_ids.add(memory_id)

        # 只输出公开字段，按固定顺序重建，避免私有字段混入
        memories.append({field: payload[field] for field in REQUIRED_FIELDS})

    memories.sort(key=lambda item: str(item["id"]))
    return memories


def write_json(path: Path, payload: Any) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    try:
        # 先编码一次，把孤立代理项这类非法 Unicode 挡在写盘之前，给出可读的错误
        text.encode("utf-8")
    except UnicodeEncodeError as error:
        die(f"输出含非法 Unicode（{error}）。检查 memories/ 里是否有 \\ud800 这类孤立代理项")
    # newline="\n" 保证 Windows 上也不会写成 CRLF，避免无意义的 diff
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    print(f"[ OK ] 写入 {path.relative_to(ROOT).as_posix()}（{path.stat().st_size} 字节）")


def main() -> int:
    parser = argparse.ArgumentParser(description="聚合公开记忆到 dist/")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="输出目录，默认 dist/")
    args = parser.parse_args()

    ensure_valid()

    memories = load_memories()
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    index_payload = {
        "schema_version": SCHEMA_VERSION,
        "license": LICENSE,
        "source": "memories/",
        "count": len(memories),
        "memories": memories,
    }

    write_json(out_dir / "memories.json", index_payload)
    write_json(out_dir / "memories.array.json", memories)

    print(f"\n聚合完成：{len(memories)} 条公开记忆 → {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
