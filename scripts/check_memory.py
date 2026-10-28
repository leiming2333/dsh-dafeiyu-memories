#!/usr/bin/env python3
"""check_memory.py —— 公开记忆的守门人

用法：
    python scripts/check_memory.py
    python scripts/check_memory.py memories/0002.json   # 只查指定文件

检查项：
1. JSON Schema（schema/memory.schema.json，2020-12）—— 有 jsonschema 就用它，
   没装则退回内置校验（字段/类型/长度/枚举/未知字段），保证 CI 不会因为缺依赖而放行。
2. id：四位数字、全库唯一。
3. 正文：20-300 字（按 Unicode 字符计，中文一个字算一个）。
4. 标题：2-40 字；标签：1-8 个、每个 ≤16 字、不重复。
5. 隐私：手机号、邮箱、身份证、QQ、微信号、群号、链接、@提及、地址、学校、单位。
6. 明显不是虚构的字段：contributor 不能是邮箱/手机号，content 不能只有空白。

退出码：0 全部通过；1 有失败；2 用法/环境错误。
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
MEMORIES_DIR = ROOT / "memories"
SCHEMA_PATH = ROOT / "schema" / "memory.schema.json"

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

CONTENT_MIN, CONTENT_MAX = 20, 300
TITLE_MIN, TITLE_MAX = 2, 40
MEMORY_TYPES = ("fiction", "semi-fiction")
LICENSE = "CC0-1.0"

# 与 src/privacy.ts 保持同一套规则（顺序也一致，方便对照）。
PRIVACY_RULES: list[tuple[str, str, str]] = [
    ("手机号", r"(?<!\d)1[3-9]\d{9}(?!\d)", "public"),
    ("邮箱", r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "public"),
    (
        "身份证",
        r"(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dXx])",
        "public",
    ),
    ("群号", r"(?:群号|群聊号|QQ\s*群|qq\s*群)\s*[:：]?\s*\d{5,12}", "public"),
    ("QQ号", r"(?:QQ|qq|Qq|qQ|扣扣)\s*(?:号码|号)?\s*[:：]?\s*[1-9]\d{4,10}", "public"),
    (
        "微信号",
        r"(?:微信号|微信|WeChat|wechat|VX|vx|V信)\s*(?:号|ID|id)?\s*[:：]?\s*[A-Za-z][-_A-Za-z0-9]{5,19}",
        "public",
    ),
    ("链接", r"https?://[^\s，。；、）)】]+", "public"),
    ("提及", r"@[A-Za-z0-9_\u4e00-\u9fa5-]{2,20}", "public"),
    ("地址", r"[\u4e00-\u9fa5]{2,8}(?:省|自治区|市)[\u4e00-\u9fa5]{2,8}(?:市|区|县|旗)", "strict"),
    ("地址", r"[\u4e00-\u9fa5]{2,10}(?:路|街|大道)[\u4e00-\u9fa5\d]{0,6}号", "strict"),
    ("地址", r"[\u4e00-\u9fa5]{2,10}小区(?:[\u4e00-\u9fa5\d]{0,8}(?:栋|号楼|单元|室|号))?", "strict"),
    ("地址", r"\d{1,4}(?:号楼|栋|单元)\d{0,4}(?:室|号)?", "strict"),
    ("学校", r"[\u4e00-\u9fa5]{2,12}(?:大学|学院|中学|小学|附中|附小|职校|技校)", "strict"),
    ("单位", r"[\u4e00-\u9fa5]{2,10}(?:有限公司|公司|集团|研究院|研究所|事务所|医院|银行)", "strict"),
]

LEADING_NOISE = re.compile(r"^(?:他们|她们|我们|你们|他|她|我|你|它|的|了|在|从|到|和|跟|去了|来到|回到|离开|走进)+")
GENERIC_ONLY = re.compile(
    r"^(?:[一二两三四五六七八九十这那某每]\s*(?:家|所|个|座|间)?)?"
    r"(?:医院|公司|学校|银行|集团|大学|学院|中学|小学|超市|商场|单位)$"
)
GENERIC_SUFFIX = re.compile(
    r"(?:这|那|一|某|每|两|几)\s*(?:家|所|个|座|间)?\s*"
    r"(?:医院|公司|学校|银行|集团|大学|学院|中学|小学|超市|商场)$"
)
ADDRESS_KINDS = {"地址", "学校", "单位"}


def is_false_positive(label: str, raw: str) -> bool:
    """只对地址/学校/单位做泛称判断：『他去了医院』跳过，『在字节跳动公司』命中。"""
    if label not in ADDRESS_KINDS:
        return False
    stripped = LEADING_NOISE.sub("", raw)
    return bool(GENERIC_ONLY.match(stripped) or GENERIC_SUFFIX.search(stripped))


def is_github_actions() -> bool:
    return os.environ.get("GITHUB_ACTIONS") == "true"


def emit_error(path: Path, message: str) -> None:
    if is_github_actions():
        try:
            relative = path.relative_to(ROOT).as_posix()
        except ValueError:
            relative = path.as_posix()
        print(f"::error file={relative}::{message}")
    else:
        print(f"  - {message}")


def char_len(text: str) -> int:
    """按 Unicode 字符计数（Python 3 的 len 对中文/emoji 都是一字一算）。"""
    return len(text)


# ───────────────────────── Schema ─────────────────────────


def load_schema() -> dict[str, Any] | None:
    try:
        return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def validate_with_jsonschema(payload: Any, schema: dict[str, Any]) -> list[str]:
    """用 jsonschema 库做完整校验。没装返回 None 由调用方降级。"""
    try:
        import jsonschema  # type: ignore
        from jsonschema import Draft202012Validator  # type: ignore
    except ImportError:
        return []

    validator = Draft202012Validator(schema, format_checker=jsonschema.FormatChecker())
    errors: list[str] = []
    for error in sorted(validator.iter_errors(payload), key=lambda item: list(item.absolute_path)):
        location = "/".join(str(part) for part in error.absolute_path) or "(根)"
        errors.append(f"schema 校验失败 @ {location}：{error.message}")
    return errors


def builtin_validate(payload: Any) -> list[str]:
    """不依赖第三方库的兜底校验，覆盖 schema 里的硬约束。"""
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["顶层必须是 JSON 对象"]

    unknown = sorted(set(payload) - set(REQUIRED_FIELDS))
    if unknown:
        errors.append(f"出现未定义字段（additionalProperties=false）：{', '.join(unknown)}")

    for field in REQUIRED_FIELDS:
        if field not in payload:
            errors.append(f"缺少必填字段：{field}")
    if errors:
        return errors

    if not isinstance(payload["id"], str) or not re.fullmatch(r"\d{4}", payload["id"]):
        errors.append("id 必须是四位数字字符串，如 0001")
    if not isinstance(payload["fish_name"], str) or not payload["fish_name"].strip():
        errors.append("fish_name 必须是非空字符串")
    if not isinstance(payload["contributor"], str) or not payload["contributor"].strip():
        errors.append("contributor 必须是非空字符串")
    if not isinstance(payload["title"], str) or not (TITLE_MIN <= char_len(payload["title"].strip()) <= TITLE_MAX):
        errors.append(f"title 必须是 {TITLE_MIN}-{TITLE_MAX} 字")
    if not isinstance(payload["content"], str) or not (CONTENT_MIN <= char_len(payload["content"].strip()) <= CONTENT_MAX):
        errors.append(f"content 必须是 {CONTENT_MIN}-{CONTENT_MAX} 字")
    tags = payload["tags"]
    if not isinstance(tags, list) or not (1 <= len(tags) <= 8):
        errors.append("tags 必须是 1-8 个元素的数组")
    else:
        if any(not isinstance(tag, str) or not tag.strip() for tag in tags):
            errors.append("tags 里每个元素都必须是非空字符串")
        if any(char_len(tag) > 16 for tag in tags if isinstance(tag, str)):
            errors.append("tags 里每个元素不能超过 16 字")
        if len(set(tags)) != len(tags):
            errors.append("tags 不能重复")
    if payload["memory_type"] not in MEMORY_TYPES:
        errors.append("memory_type 只能是 fiction 或 semi-fiction")
    if payload["license"] != LICENSE:
        errors.append("license 必须是 CC0-1.0")
    if not isinstance(payload["created_at"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", payload["created_at"]):
        errors.append("created_at 必须是 YYYY-MM-DD")
    return errors


# ───────────────────────── 业务校验 ─────────────────────────


def has_lone_surrogate(text: str) -> bool:
    """孤立代理项：JSON 里能写 \\ud800 这种转义，但 UTF-8 编码时会直接抛错。"""
    return any(0xD800 <= ord(ch) <= 0xDFFF for ch in text)


def check_unicode(memory: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for field in ("title", "content", "contributor", "fish_name"):
        value = memory.get(field)
        if isinstance(value, str) and has_lone_surrogate(value):
            errors.append(f"{field} 含孤立代理项（半个 emoji），会导致写盘失败")
    tags = memory.get("tags")
    if isinstance(tags, list):
        for tag in tags:
            if isinstance(tag, str) and has_lone_surrogate(tag):
                errors.append("tags 含孤立代理项（半个 emoji）")
                break
    return errors


def check_content(memory: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    content = memory.get("content")
    if isinstance(content, str):
        length = char_len(content.strip())
        if length < CONTENT_MIN:
            errors.append(f"正文只有 {length} 字，低于 {CONTENT_MIN} 字下限")
        elif length > CONTENT_MAX:
            errors.append(f"正文 {length} 字，超过 {CONTENT_MAX} 字上限")
        if not content.strip():
            errors.append("正文不能为空")
    return errors


def scan_privacy(text: str) -> list[str]:
    hits: list[str] = []
    for label, pattern, _level in PRIVACY_RULES:
        for match in re.finditer(pattern, text):
            raw = match.group(0)
            if is_false_positive(label, raw):
                continue
            hits.append(f"{label}「{raw}」")
    return hits


def check_privacy(memory: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for field in ("title", "content", "contributor", "fish_name"):
        value = memory.get(field)
        if not isinstance(value, str):
            continue
        for hit in scan_privacy(value):
            errors.append(f"{field} 含疑似隐私：{hit}")
    tags = memory.get("tags")
    if isinstance(tags, list):
        for tag in tags:
            if not isinstance(tag, str):
                continue
            for hit in scan_privacy(tag):
                errors.append(f"tags 含疑似隐私：{hit}")
    return errors


def check_one(path: Path, schema: dict[str, Any] | None, seen_ids: dict[str, Path]) -> list[str]:
    errors: list[str] = []

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        return [f"JSON 解析失败：{error.msg}（第 {error.lineno} 行）"]
    except OSError as error:
        return [f"读取失败：{error}"]

    if schema is not None:
        schema_errors = validate_with_jsonschema(payload, schema)
        errors.extend(schema_errors if schema_errors else builtin_validate(payload))
    else:
        errors.append("未找到 schema/memory.schema.json，改用内置校验")
        errors.extend(builtin_validate(payload))

    if not isinstance(payload, dict):
        return errors

    errors.extend(check_content(payload))
    errors.extend(check_unicode(payload))
    errors.extend(check_privacy(payload))

    memory_id = payload.get("id")
    if isinstance(memory_id, str):
        if memory_id in seen_ids:
            other = seen_ids[memory_id]
            errors.append(f"id {memory_id} 与 {other.name} 重复")
        else:
            seen_ids[memory_id] = path

    return errors


def main(argv: list[str]) -> int:
    if not MEMORIES_DIR.exists():
        print(f"[FATAL] 找不到公开记忆目录：{MEMORIES_DIR}", file=sys.stderr)
        return 2

    if argv:
        files = [Path(item) for item in argv]
    else:
        files = sorted(
            path
            for path in MEMORIES_DIR.glob("*.json")
            if path.name != "template.json"
        )

    if not files:
        print("[WARN] memories/ 下没有可校验的公开记忆（template.json 不算）")
        return 0

    schema = load_schema()
    if schema is None:
        print("[WARN] schema/memory.schema.json 缺失或无法解析，改用内置校验")

    seen_ids: dict[str, Path] = {}
    failed = 0

    for path in files:
        errors = check_one(path, schema, seen_ids)
        if errors:
            failed += 1
            print(f"[FAIL] {path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path}")
            for message in errors:
                emit_error(path, message)
        else:
            print(f"[ OK ] {path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path}")

    total = len(files)
    print(f"\n共 {total} 个文件：{total - failed} 通过，{failed} 失败")
    if failed:
        print("请对照 docs/review-checklist.md 逐项修正后重新运行。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
