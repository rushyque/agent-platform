import json, sys, urllib.request, random, string, uuid

BASE = sys.argv[1]
TAG  = sys.argv[2] if len(sys.argv) > 2 else "run"
WHICH = sys.argv[3] if len(sys.argv) > 3 else "B"   # A / B / AB

def dev_login(case):
    uid = "probe_" + TAG + "_" + case + "_" + "".join(random.choices(string.ascii_lowercase, k=4))
    req = urllib.request.Request(
        BASE + "/game/api/dev-login",
        data=json.dumps({"userId": uid}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    return uid, json.loads(urllib.request.urlopen(req, timeout=10).read())["token"]

def run_case(text, tok, case_id):
    rid = uuid.uuid4().hex[:8]
    tid = "th-" + TAG + "-" + case_id + "-" + rid
    body = json.dumps({
        "threadId": tid, "runId": "r-" + rid, "state": {},
        "messages": [{"id": "m1", "role": "user", "content": text}],
        "tools": [], "context": []})
    req = urllib.request.Request(
        BASE + "/agent/starlink_factory/run", data=body.encode(),
        headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"}, method="POST")
    resp = urllib.request.urlopen(req, timeout=280)
    chunks = []
    for line in resp:
        chunks.append(line)
        if b'"RUN_FINISHED"' in line or b'"RUN_ERROR"' in line:
            break
    raw = b"".join(chunks).decode("utf-8", errors="replace")
    evs = []
    for l in raw.splitlines():
        if l.startswith("data: "):
            try: evs.append(json.loads(l[6:]))
            except: pass
    return evs

def analyze(evs):
    id2name = {}; argmap = {}
    for e in evs:
        if e.get("type") == "TOOL_CALL_START":
            cid = e.get("toolCallId"); id2name[cid] = e.get("toolCallName"); argmap[cid] = ""
        elif e.get("type") == "TOOL_CALL_ARGS":
            cid = e.get("toolCallId")
            if cid in argmap: argmap[cid] += e.get("delta", "")
    calls = [(id2name[cid], argmap.get(cid, "")) for cid in id2name]
    notfound = 0
    for e in evs:
        if e.get("type") == "TOOL_CALL_RESULT":
            r = e.get("result") or ""
            if isinstance(r, str) and "artifact not found" in r: notfound += 1
    texts = {}; order = []
    for e in evs:
        if e.get("type") == "TEXT_MESSAGE_START":
            mid = e.get("messageId"); texts[mid] = ""; order.append(mid)
        elif e.get("type") == "TEXT_MESSAGE_CONTENT" and e.get("messageId") in texts:
            texts[e.get("messageId")] += e.get("delta", "")
    return calls, notfound, "\n".join(texts[m] for m in order)

CASES = []
if WHICH in ("A","AB"): CASES.append(("A_view",    "查看一下工厂现状，简单说说"))
if WHICH in ("B","AB"): CASES.append(("B_pipeline","查看工厂现状，然后接下第一个询价单开始运营"))

print(f"########## TAG={TAG} BASE={BASE} WHICH={WHICH} ##########")
for case_id, text in CASES:
    try:
        uid, tok = dev_login(case_id)
        evs = run_case(text, tok, TAG + "_" + case_id)
        calls, notfound, alltext = analyze(evs)
        from collections import Counter
        freq = Counter(c[0] for c in calls)
        ro_rep = sum(v - 1 for k, v in freq.items() if k.startswith("factory_view") or k == "factory_list_orders")
        print(f"\n===== {case_id}  uid={uid} =====")
        print(f"总调用={len(calls)}  getArtifact={freq.get('getArtifact',0)}  notFound={notfound}  只读重复={ro_rep}")
        print("序列:", " > ".join(c[0].replace("factory_","f.") for c in calls))
        print("汇报片段(前350字):", alltext[:350].replace("\n"," "))
    except Exception as ex:
        print(f"\n===== {case_id}  ERROR: {type(ex).__name__}: {ex} =====")
