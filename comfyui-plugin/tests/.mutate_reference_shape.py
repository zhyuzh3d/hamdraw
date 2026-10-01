#!/usr/bin/env python3
"""把参考图形状那道守卫改坏，确认两条断言各自真的在管它。

每行是 (改坏的写法, 文件, 原文, 替换, 必须出现的那句断言)。最后一列是关键：这份脚本
里跑的两个测试都可能因为别的原因失败，只有输出里出现**点名那一句**才算抓住。
    python3 tests/.mutate_reference_shape.py
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHECKPOINT = "hamdraw_chp/families/checkpoint.py"
GRAPH_TEST = "tests/test_mask_graph.py"

MUTATIONS = [
    (
        "守卫从 build 里被摘掉（函数还在，没人调用）",
        CHECKPOINT,
        '    if not reference_fits(reference_pixels(image), (width, height)):\n        raise ValueError("stretched_reference")\n',
        "",
        "形状不符的参考图必须被 build 拒绝",
    ),
    (
        "判据永远放行",
        CHECKPOINT,
        "    if width <= 0 or height <= 0:\n        return True\n    target_width, target_height = reference_canvas(size)\n    return width * target_height == height * target_width",
        "    return True",
        "4:3 的参考图进 1:1 的任务就是拉伸",
    ),
    (
        # 这条专门证伪"比的是形状还是像素数"。注意它**不会**被 4:3 那条抓住 ——
        # 逐边相等的比法同样会否掉 576×384，所以 4:3 那条留在绿上；抓住它的是
        # 2048 那条：2048 的任务按 1024 编码，比例没变，逐边比却会误判。
        "把形状判成像素数逐边相等",
        CHECKPOINT,
        "    return width * target_height == height * target_width",
        "    return width == target_width",
        "2048 的任务按 1024 编码，比例没变就仍然合适",
    ),
]

originals = {}
for _, file, _, _, _ in MUTATIONS:
    originals.setdefault(file, (ROOT / file).read_text(encoding="utf-8"))

escaped = []
try:
    for index, (name, file, find, replace, expected) in enumerate(MUTATIONS):
        path = ROOT / file
        original = originals[file]
        if find not in original:
            escaped.append(name + "（锚点没找到，改不动）")
            print("SKIP  " + name)
            continue
        path.write_text(original.replace(find, replace, 1), encoding="utf-8")
        try:
            done = subprocess.run([sys.executable, str(ROOT / GRAPH_TEST)],
                                  capture_output=True, text=True)
            output = done.stdout + done.stderr
        finally:
            path.write_text(original, encoding="utf-8")
        caught = expected in output
        line = next((row.strip() for row in output.splitlines() if "AssertionError" in row), "(没有断言失败)")
        print(("CAUGHT " if caught else "ESCAPED") + " " + name + "\n        " + line)
        if not caught:
            escaped.append(name + " —— 期望看到: " + expected)
        if path.read_text(encoding="utf-8") != original:
            raise SystemExit(file + " 没有还原")
finally:
    for file, body in originals.items():
        (ROOT / file).write_text(body, encoding="utf-8")

if escaped:
    print("\n参考图形状变异检查 FAILED:\n  " + "\n  ".join(escaped))
    sys.exit(1)
print("\n参考图形状变异检查: ok（" + str(len(MUTATIONS)) + " 处变异，全部按名字抓住）")
