#!/usr/bin/env python3
"""Reassemble streamed text (content + reasoning_content) from raw SSE captures and scan for
joined words with an inflection-aware dictionary check. Lanes: direct (DeepInfra) vs gateway."""
import glob
import json
import re
from collections import defaultdict

WORDS = set(w.strip().lower() for w in open("/usr/share/dict/words") if len(w.strip()) > 1)
WORDS |= {"a", "i"}
FUNC = set("to or and that then it is in on of as at we be so the can will not with for but they this you".split())
IRREGULAR = set(
    "began begun became become gave given took taken kept knew known grew grown drew drawn threw thrown "
    "led fed met sat won lost sent spent built felt held left meant read said paid laid made found heard "
    "brought bought thought taught caught sought fought stood understood ran come came went gone done saw "
    "seen wrote written rode ridden rose risen chose chosen spoke spoken broke broken froze frozen drove "
    "driven ate eaten fell fallen flew flown laid lain lay slept swept wept crept dealt dreamt burnt learnt "
    "bent lent shone shot sold told struck strung swung clung sprang sprung sank sunk drank drunk rang rung "
    "sang sung swam swum forgot forgotten got gotten hid hidden bit bitten beat beaten lit slid stuck stung "
    "tore torn wore worn swore sworn bore borne bound wound ground hung dug spun wove woven".split()
)


def is_known(word: str) -> bool:
    if word in WORDS or word in IRREGULAR:
        return True
    for suffix, restores in (("ing", ("", "e")), ("ed", ("", "e")), ("es", ("",)), ("s", ("",)), ("d", ("",)), ("ly", ("",)), ("er", ("", "e")), ("est", ("", "e"))):
        if word.endswith(suffix) and len(word) > len(suffix) + 2:
            stem = word[: -len(suffix)]
            for restore in restores:
                if stem + restore in WORDS or stem + restore in IRREGULAR:
                    return True
            # doubled final consonant: running -> run
            if len(stem) > 2 and stem[-1] == stem[-2] and stem[:-1] in WORDS:
                return True
    return False


def scan(text: str):
    hits = []
    for m in re.finditer(r",(?=[A-Za-z])", text):
        hits.append(("comma-join", text[max(0, m.start() - 30) : m.start() + 30]))
    for m in re.finditer(r"[A-Za-z']+", text):
        w = m.group().lower().replace("'", "")
        if len(w) < 5 or is_known(w):
            continue
        for i in range(2, len(w) - 1):
            left, right = w[:i], w[i:]
            if (left in FUNC or right in FUNC) and is_known(left) and is_known(right):
                hits.append((f"split:{left}|{right}", text[max(0, m.start() - 30) : m.start() + 40]))
                break
    return hits


totals = defaultdict(lambda: {"calls": 0, "chars": 0, "hits": 0})
findings = []
for path in sorted(glob.glob("results/*.sse.jsonl")):
    lane = "direct" if "direct" in path else "gateway"
    content, reasoning = [], []
    for line in open(path):
        line = line.strip()
        if not line or line == "[DONE]":
            continue
        try:
            delta = json.loads(line).get("choices", [{}])[0].get("delta", {})
        except Exception:
            continue
        if isinstance(delta.get("content"), str):
            content.append(delta["content"])
        if isinstance(delta.get("reasoning_content"), str):
            reasoning.append(delta["reasoning_content"])
    text = "".join(content) + "\n" + "".join(reasoning)
    hits = scan(text)
    totals[lane]["calls"] += 1
    totals[lane]["chars"] += len(text)
    totals[lane]["hits"] += len(hits)
    for kind, snippet in hits:
        findings.append((lane, path.split("/")[-1], kind, snippet.replace("\n", " ")))

print("── space-drop analysis (content + reasoning) ──")
for lane in ("direct", "gateway"):
    t = totals[lane]
    print(f"{lane}: {t['hits']} hit(s) in {t['calls']} calls (~{t['chars']//4} tokens)")
print()
for lane, tag, kind, snippet in findings:
    print(f"[{lane}] {tag} {kind}: …{snippet}…")
