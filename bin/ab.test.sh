#!/bin/bash
# Tests ab.mjs against a temp copy of board.ts (AB_NO_SERVER=1), never the live file.
set -u
AB="$(dirname "$0")/ab.mjs"; SRC="${1:-$(dirname "$0")/../app/src/data/board.ts}"
T=$(mktemp -d); mkdir -p "$T/app/src/data"; cp "$SRC" "$T/app/src/data/board.ts"
cp "$(dirname "$0")/../app/src/data/project.ts" "$T/app/src/data/project.ts"
# Keep the shell's settings out: the footer checks below set their own.
unset AB_URL ACTION_BOARD_HOST ACTION_BOARD_PORT
export AB_FILE="$T/app/src/data/board.ts" AB_PROJECT_FILE="$T/app/src/data/project.ts" AB_NO_SERVER=1
export AB_EVENTS_FILE="$T/data/events.jsonl"
pass=0; fail=0
t() { local want=$1; shift; local name=$1; shift; out=$("$@" 2>&1); got=$?; if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "PASS $name"; else fail=$((fail+1)); echo "FAIL $name (exit $got, want $want): $out"; fi; }
# Every raise must say whether the card blocks something; test cards built on CTX block nothing.
CTX='"context":"Test card for the ab checks, standing in for a real ticket that needs a call.","blocking":false'
D='{"id":"t-one","title":"Test one",'"$CTX"',"question":"Q?","what_happens_after":"A.","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"link":"https://example.com/pr/1"}'
t 0 "raise prints card"            node "$AB" raise "$D"
t 0 "card has title+footer"        bash -c "node '$AB' raise '$D' | grep -qF 'Also on your Action Board: http://board.localhost:8085 (t-one)' "
t 0 "footer uses host and port from the env"  bash -c "ACTION_BOARD_HOST=team.localhost ACTION_BOARD_PORT=5199 node '$AB' raise '$D' | grep -qF 'http://team.localhost:5199 (t-one)'"
printf 'ACTION_BOARD_HOST=file.localhost\nACTION_BOARD_PORT="5200"\n' > "$T/app/.env.local"
t 0 "footer uses host and port from app/.env.local"  bash -c "node '$AB' raise '$D' | grep -qF 'http://file.localhost:5200 (t-one)'"
rm "$T/app/.env.local"
t 0 "open lists it"                bash -c "node '$AB' open | grep -q t-one"
t 2 "raise without title refused"  node "$AB" raise '{"id":"t-two",'"$CTX"',"question":"Q","what_happens_after":"A","options":[{"id":"a","label":"A"}]}'
t 2 "raise unknown field refused"  node "$AB" raise '{"id":"t-two","title":"Test two",'"$CTX"',"question":"Q","what_happens_after":"A","options":[{"id":"a","label":"A"}],"links":"x"}'
t 2 "raise with input that is not JSON"  bash -c "echo 'not json' | node '$AB' raise"
t 0 "  ...says so, no stack trace"  bash -c "echo 'not json' | node '$AB' raise 2>&1 | grep -qx 'ab: raise: input is not valid JSON.*'"
t 2 "glance with input that is not JSON"  bash -c "echo '{' | node '$AB' glance"
t 2 "backfill-titles with input that is not JSON"  bash -c "echo '[' | node '$AB' backfill-titles"
t 2 "raise with a JSON array"  bash -c "echo '[1]' | node '$AB' raise"
t 2 "reserved custom option"       node "$AB" raise '{"id":"t-two","title":"Test two",'"$CTX"',"question":"Q","what_happens_after":"A","options":[{"id":"custom","label":"A"}]}'
t 1 "check: chat card missing from board"  node "$AB" check --chat t-one,never-raised
t 1 "check: board-only decision"           node "$AB" check --chat ""
# make the temp board deterministic: only t-one open
node -e 'const fs=require("fs"),f=process.env.AB_FILE,s=fs.readFileSync(f,"utf8"),A="/* BOARD-JSON-START */",i=s.indexOf(A)+A.length,j=s.indexOf("/* BOARD-JSON-END */");const b=JSON.parse(s.slice(i,j));b.decisions=b.decisions.filter(d=>d.answer||d.id==="t-one");fs.writeFileSync(f,s.slice(0,i)+"\n"+JSON.stringify(b,null,2)+"\n"+s.slice(j))'
t 0 "check: chat and board agree"          node "$AB" check --chat t-one
t 0 "answer via app"               node "$AB" answer t-one a --by app --at 2026-11-10T17:00:00.000Z
t 0 "answer retry is idempotent"   bash -c "node '$AB' answer t-one b --by chat | grep -q already-answered"
t 4 "re-raise answered refused"    node "$AB" raise "$D"
t 1 "check: answered chat card flagged"   node "$AB" check --chat t-one
t 0 "clear"                        node "$AB" clear t-one --reason "test"
t 4 "re-raise cleared refused"     node "$AB" raise "$D"
t 0 "board still parses"           node -e 'const s=require("fs").readFileSync(process.env.AB_FILE,"utf8");const A="/* BOARD-JSON-START */";const b=JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf("/* BOARD-JSON-END */")));if(!Array.isArray(b.decisions)||!b.glance)process.exit(1)'
t 0 "glance without parked"        bash -c "echo '{\"waiting\":[],\"tickets\":[]}' | node '$AB' glance | grep -q '\"counts\":{\"waiting\":0,\"tickets\":0,\"others\":0}'"
t 0 "glance with empty parked"     bash -c "echo '{\"waiting\":[],\"parked\":[],\"tickets\":[]}' | node '$AB' glance"
t 0 "written glance has no parked key"  node -e 'const s=require("fs").readFileSync(process.env.AB_FILE,"utf8");const A="/* BOARD-JSON-START */";const g=JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf("/* BOARD-JSON-END */"))).glance;if(JSON.stringify(Object.keys(g))!==JSON.stringify(["waiting","tickets","others"]))process.exit(1)'
SUM=$(cksum < "$AB_FILE")
t 2 "glance with non-empty parked refused"  bash -c "echo '{\"waiting\":[],\"parked\":[{\"title\":\"P\"}],\"tickets\":[]}' | node '$AB' glance"
t 0 "parked refusal says use ab raise"      bash -c "echo '{\"waiting\":[],\"parked\":[{\"title\":\"P\"}],\"tickets\":[]}' | node '$AB' glance 2>&1 | grep -q 'glance.parked is retired: raise those as decisions with \"ab raise\" instead'"
t 2 "glance with non-array parked refused"  bash -c "echo '{\"waiting\":[],\"parked\":{},\"tickets\":[]}' | node '$AB' glance"
t 0 "parked refusals leave board.ts unchanged"  test "$(cksum < "$AB_FILE")" = "$SUM"
# others: someone else's PR involving the user. Optional (missing = []); each item exactly {title, author, who, link}.
gget() { node -e 'const s=require("fs").readFileSync(process.env.AB_FILE,"utf8");const A="/* BOARD-JSON-START */";console.log(JSON.stringify(JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf("/* BOARD-JSON-END */"))).glance.others))'; }
OK1='{"title":"Tax tiers","author":"Blake","who":"Your review requested","link":"https://github.com/acme/example/pull/11800"}'
OK2='{"title":"Billing banner","author":"Riley","who":"Blake'"'"'s fixes","link":"http://example.com/pr/2"}'
echo '{"waiting":[],"tickets":[],"others":['"$OK1,$OK2"']}' > "$T/others.json"
t 0 "glance with others: counts include others"  bash -c "node '$AB' glance < '$T/others.json' | grep -q '\"counts\":{\"waiting\":0,\"tickets\":0,\"others\":2}'"
t 0 "  ...file has them, in order"   test "$(gget)" = "[$OK1,$OK2]"
t 0 "check reports the others count" bash -c "node '$AB' check | node -e 'const r=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));if(JSON.stringify(r.counts)!==JSON.stringify({waiting:0,tickets:0,others:2}))process.exit(1)'"
t 0 "glance without others: others becomes []"  bash -c "echo '{\"waiting\":[],\"tickets\":[]}' | node '$AB' glance | grep -q '\"others\":0}'"
t 0 "  ...file has others []"        test "$(gget)" = "[]"
# A board written before others existed: check passes and counts others as 0.
node -e 'const fs=require("fs"),f=process.env.AB_FILE,s=fs.readFileSync(f,"utf8"),A="/* BOARD-JSON-START */",i=s.indexOf(A)+A.length,j=s.indexOf("/* BOARD-JSON-END */");const b=JSON.parse(s.slice(i,j));delete b.glance.others;fs.writeFileSync(f,s.slice(0,i)+"\n"+JSON.stringify(b,null,2)+"\n"+s.slice(j))'
t 0 "check on a board without others exits 0"  node "$AB" check
t 0 "  ...and reports others 0"      bash -c "node '$AB' check | grep -q '\"others\": 0'"
SUM=$(cksum < "$AB_FILE")
oth() { echo '{"waiting":[],"tickets":[],"others":'"$1"'}' | node "$AB" glance; }
t 2 "others not an array refused"    oth '{}'
t 0 "  ...error says so"             bash -c "$(declare -f oth); AB='$AB' oth '\"x\"' 2>&1 | grep -qF 'ab: glance.others must be an array'"
t 2 "others item missing author"     oth '[{"title":"T","who":"W","link":"https://example.com/1"}]'
t 0 "  ...error names the item and key"  bash -c "$(declare -f oth); AB='$AB' oth '[$OK1,{\"title\":\"T\",\"who\":\"W\",\"link\":\"https://example.com/1\"}]' 2>&1 | grep -qF 'ab: glance.others[1].author must be a non-blank string'"
t 2 "others item blank who"          oth '[{"title":"T","author":"A","who":"  ","link":"https://example.com/1"}]'
t 2 "others item extra key"          oth '[{"title":"T","author":"A","who":"W","link":"https://example.com/1","status":"Open"}]'
t 0 "  ...error names the key"       bash -c "$(declare -f oth); AB='$AB' oth '[{\"title\":\"T\",\"author\":\"A\",\"who\":\"W\",\"link\":\"https://example.com/1\",\"status\":\"Open\"}]' 2>&1 | grep -qF 'ab: glance.others[0] has unknown key status'"
t 2 "others item non-http link"      oth '[{"title":"T","author":"A","who":"W","link":"ftp://x.y/1"}]'
t 0 "  ...error names the link"      bash -c "$(declare -f oth); AB='$AB' oth '[{\"title\":\"T\",\"author\":\"A\",\"who\":\"W\",\"link\":\"x.y/1\"}]' 2>&1 | grep -qF 'ab: glance.others[0].link must start with http:// or https://'"
t 2 "others item non-string title"   oth '[{"title":3,"author":"A","who":"W","link":"https://example.com/1"}]'
for bad in '"PR"' 'null' '[]' '3'; do
  t 2 "others item $bad (not an object) refused"  oth "[$bad]"
done
t 0 "others refusals leave board.ts unchanged"  test "$(cksum < "$AB_FILE")" = "$SUM"
N='{"id":"t-nocustom","title":"No custom",'"$CTX"',"question":"Q?","what_happens_after":"A.","options":[{"id":"a","label":"A"}],"allowCustom":false}'
t 0 "raise allowCustom:false"      node "$AB" raise "$N"
SUM=$(cksum < "$AB_FILE")
t 2 "custom answer refused when allowCustom is false"  node "$AB" answer t-nocustom --custom "my own" --by chat
t 0 "refusal says why"             bash -c "node '$AB' answer t-nocustom --custom 'my own' --by chat 2>&1 | grep -q 't-nocustom does not allow a custom answer'"
t 0 "refusal leaves board.ts unchanged"  test "$(cksum < "$AB_FILE")" = "$SUM"
t 0 "option answer still works"    node "$AB" answer t-nocustom a --by chat
# details: optional structure under the question
board() { node -e 'const s=require("fs").readFileSync(process.env.AB_FILE,"utf8");const A="/* BOARD-JSON-START */";const b=JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf("/* BOARD-JSON-END */")));const d=b.decisions.find(x=>x.id===process.argv[1]);console.log(!d?"MISSING":"details" in d?JSON.stringify(d.details):"absent")' "$1"; }
DET='["Reads CRM contacts nightly",{"label":"Defaults","items":["Sync every 24h","Read-only"]},{"label":"Tradeoffs","ordered":true,"items":["Cheaper","Slower to show changes"]}]'
dec() { echo '{"id":"'"$1"'","title":"CRM sync details",'"$CTX"',"question":"Turn on CRM sync?","what_happens_after":"The assistant turns it on.","options":[{"id":"a","label":"A"}],"details":'"$2"'}'; }
t 0 "raise with details"           node "$AB" raise "$(dec t-details "$DET")"
t 0 "details written to board"     test "$(board t-details)" = "$DET"
t 0 "card carries details as text" bash -c "node '$AB' raise '$(dec t-details "$DET")' | grep -qF '\"details\": \"- Reads CRM contacts nightly\\nDefaults:\\n- Sync every 24h\\n- Read-only\\nTradeoffs:\\n1. Cheaper\\n2. Slower to show changes\"'"
P='{"id":"t-plain","title":"Plain card",'"$CTX"',"question":"Q?","what_happens_after":"A.","options":[{"id":"a","label":"A"}]}'
t 0 "card without details has no details key"   bash -c "! node '$AB' raise '$P' | grep -q details"
t 0 "raise without details writes no details key"  test "$(board t-plain)" = "absent"
SUM=$(cksum < "$AB_FILE")
for bad in '"text"' '{}' '[]' '[""]' '["  "]' '[3]' '[null]' '[["a"]]' '[{"items":["x"]}]' '[{"label":"","items":["x"]}]' '[{"label":"L"}]' '[{"label":"L","items":[]}]' '[{"label":"L","items":"x"}]' '[{"label":"L","items":["x",""]}]' '[{"label":"L","items":[1]}]' '[{"label":"L","items":["x"],"ordered":"yes"}]' '[{"label":"L","items":["x"],"extra":1}]'; do
  t 2 "details $bad refused"       node "$AB" raise "$(dec t-bad "$bad")"
done
t 0 "details refusal says why"     bash -c "node '$AB' raise '$(dec t-bad '[{"label":"L","items":["x"],"extra":1}]')' 2>&1 | grep -q 'details\[0\] has unknown key extra'"
t 0 "details refusals leave board.ts unchanged"  test "$(cksum < "$AB_FILE")" = "$SUM"
# Plain words: context required, no vague question, title more than an id. Refusals exit 2 and leave board.ts alone.
OLD='{"id":"proj15054-old","title":"PROJ-15054","question":"What should happen to the ticket?","what_happens_after":"Ellis acts on your pick.","options":[{"id":"cancel","label":"Cancel"}],"blocking":false}'
GOODCTX='"context":"Ticket PROJ-15054 asks for a required asterisk on the Address field of the employee emergency contact form. Product (Quinlan) says Address is optional, so the ticket asks for something product does not want."'
withctx() { echo "$OLD" | sed "s/\"question\"/$GOODCTX,\"question\"/"; }
SUM=$(cksum < "$AB_FILE")
t 2 "old PROJ-15054 card refused"            node "$AB" raise "$OLD"
t 0 "old card refusal names context"        bash -c "node '$AB' raise '$OLD' 2>&1 | grep -q '^ab: context is required'"
t 2 "old card with context still refused"   node "$AB" raise "$(withctx)"
t 0 "refusal names the vague question"      bash -c "node '$AB' raise '$(withctx)' 2>&1 | grep -qF 'ab: question: \"the ticket\" is vague. Name the thing in plain words, for example \"the Q3 vendor contract\".'"
FIXQ=$(withctx | sed 's/What should happen to the ticket?/Close the emergency contact Address asterisk ticket?/')
t 2 "id-only title refused"                 node "$AB" raise "$FIXQ"
t 0 "refusal names the title"               bash -c "node '$AB' raise '$FIXQ' 2>&1 | grep -qF 'ab: title: \"PROJ-15054\" is only an id. Add plain words saying what it is, for example \"ABC-1234 Checkout button color\".'"
for q in "Should the PR be merged?" "Send it back to Quinlan?" "Ship that?" "Merge this pull request"; do
  t 2 "vague question refused: $q"        node "$AB" raise "$(echo "$FIXQ" | sed "s/Close the emergency contact Address asterisk ticket?/$q/")"
done
GOOD=$(echo "$FIXQ" | sed 's/"id":"proj15054-old","title":"PROJ-15054"/"id":"proj15054-close","title":"PROJ-15054 Emergency contact Address asterisk"/')
for c in '"context":"PROJ-15054 #12 https://example.com/z fix"' '"context":"One. Two. Three. Four five more words here."' '"context":"   "' '"context":3' "\"context\":\"$(printf 'word %.0s' $(seq 121))\""; do
  BAD=$(echo "$GOOD" | sed "s|$GOODCTX|$c|")
  t 2 "bad context refused: ${c:0:50}"    node "$AB" raise "$BAD"
  t 0 "  ...and the error names context"  bash -c "node '$AB' raise '$BAD' 2>&1 | grep -q '^ab: context'"
done
t 0 "plain-words refusals leave board.ts unchanged"  test "$(cksum < "$AB_FILE")" = "$SUM"
t 0 "good PROJ-15054 card raised"            node "$AB" raise "$GOOD"
t 0 "card leads with title, context, question"  bash -c "node '$AB' raise '$GOOD' | node -e 'const c=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")).card;if(Object.keys(c).slice(0,3).join()!==\"title,context,question\"||!c.context.startsWith(\"Ticket PROJ-15054 asks\"))process.exit(1)'"
t 0 "context stored on the board"           node -e 'const s=require("fs").readFileSync(process.env.AB_FILE,"utf8");const A="/* BOARD-JSON-START */";const d=JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf("/* BOARD-JSON-END */"))).decisions.find(x=>x.id==="proj15054-close");if(!d.context.startsWith("Ticket PROJ-15054 asks"))process.exit(1)'
# lint: open decisions only, stored fields only.
seed() { node -e 'const fs=require("fs"),f=process.env.AB_FILE,s=fs.readFileSync(f,"utf8"),A="/* BOARD-JSON-START */",i=s.indexOf(A)+A.length,j=s.indexOf("/* BOARD-JSON-END */");const b=JSON.parse(s.slice(i,j));b.decisions=JSON.parse(process.argv[1]);fs.writeFileSync(f,s.slice(0,i)+"\n"+JSON.stringify(b,null,2)+"\n"+s.slice(j))' "$1"; }
base='"card_ref":null,"what_happens_after":"A.","options":[{"id":"a","label":"A"}],"created_at":"2026-11-10T09:00:00.000Z"'
ok='"context":"Ticket PROJ-15054 asks for a required asterisk on the emergency contact Address field."'
ans='"answer":{"answer":"a","answer_label":"A","answered_by":"chat","answered_at":"2026-11-10T10:00:00.000Z"}'
tt='"title":"Address asterisk ticket"'
seed "[{\"id\":\"l-noctx\",$tt,\"question\":\"Close the Address asterisk ticket?\",$base},{\"id\":\"l-vague\",$tt,$ok,\"question\":\"What should happen to the ticket?\",$base},{\"id\":\"l-answered\",\"question\":\"Ship it?\",$base,$ans},{\"id\":\"l-good\",$tt,$ok,\"question\":\"Close the Address asterisk ticket?\",$base}]"
t 1 "lint: failing open cards exit 1"       node "$AB" lint
t 0 "lint: flags no-context and vague, skips answered and good"  bash -c "node '$AB' lint | node -e 'const r=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));const f=Object.fromEntries(r.failing.map(x=>[x.id,x.problems.join()]));if(r.ok!==false||Object.keys(f).join()!==\"l-noctx,l-vague\"||!/^context is required/.test(f[\"l-noctx\"])||!/^question: \"the ticket\" is vague/.test(f[\"l-vague\"]))process.exit(1)'"
seed "[{\"id\":\"l-answered\",\"question\":\"Ship it?\",$base,$ans},{\"id\":\"l-good\",$tt,$ok,\"question\":\"Close the Address asterisk ticket?\",$base}]"
t 0 "lint: clean board exits 0"             bash -c "node '$AB' lint | grep -q '\"failing\": \[\]'"
# Title: required, stored first after id, shown bold on the card. Lint checks it on open cards; backfill-titles fills old ones.
lprob() { node "$AB" lint | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));const d=r.failing.find(x=>x.id===process.argv[1]);console.log(d?d.problems.join("|"):"none")' "$1"; }
seed "[{\"id\":\"l-notitle\",$ok,\"question\":\"Close the Address asterisk ticket?\",$base},{\"id\":\"l-blank\",\"title\":\"  \",$ok,\"question\":\"Close the Address asterisk ticket?\",$base},{\"id\":\"l-long\",\"title\":\"$(printf 'x%.0s' $(seq 61))\",$ok,\"question\":\"Close the Address asterisk ticket?\",$base},{\"id\":\"l-multi\",\"title\":\"Address asterisk\\nticket\",$ok,\"question\":\"Close the Address asterisk ticket?\",$base},{\"id\":\"l-idonly\",\"title\":\"PROJ-15054 ticket\",$ok,\"question\":\"Close the Address asterisk ticket?\",$base},{\"id\":\"l-answered\",\"question\":\"Ship it?\",$base,$ans}]"
t 1 "lint: open card with no title exits 1"  node "$AB" lint
for id in l-notitle l-blank l-long l-multi l-idonly; do
  t 0 "  ...$id has a problem starting \"title\""  bash -c "$(declare -f lprob); AB='$AB' lprob $id | grep -q '^title'"
done
t 0 "  ...answered card without a title is not flagged"  test "$(lprob l-answered)" = "none"
seed "[{\"id\":\"l-notitle\",$ok,\"question\":\"Close the Address asterisk ticket?\",$base},{\"id\":\"l-answered\",\"question\":\"Ship it?\",$base,$ans}]"
t 1 "lint: card with no title fails before backfill"  node "$AB" lint
t 0 "backfill-titles fixes it"              bash -c "echo '{\"l-notitle\":\"Address asterisk ticket\"}' | node '$AB' backfill-titles >/dev/null"
t 0 "  ...and lint exits 0 after"           node "$AB" lint
# Concurrency: 20 raises + 20 glances at once must not corrupt board.ts or lose a raise.
R='"context":"Concurrency test card standing in for a real ticket that needs a call.","question":"Ship the concurrency test card?","what_happens_after":"Nothing happens.","options":[{"id":"a","label":"A"}],"blocking":false'
pids=()
for n in $(seq 1 20); do
  node "$AB" raise '{"id":"t-race-'$n'","title":"Race card '$n'",'"$R"'}' >/dev/null 2>&1 & pids+=($!)
  echo '{"waiting":[],"tickets":[]}' | node "$AB" glance >/dev/null 2>&1 & pids+=($!)
done
codes=""; for p in "${pids[@]}"; do wait "$p"; codes="$codes$?"; done
t 0 "race: all 40 parallel writes exit 0"   test "$codes" = "$(printf '0%.0s' $(seq 40))"
t 0 "race: one END marker, JSON parses, all 20 raised ids present"  node -e 'const s=require("fs").readFileSync(process.env.AB_FILE,"utf8");const A="/* BOARD-JSON-START */",Z="/* BOARD-JSON-END */";if(s.split(Z).length!==2)throw "END markers: "+(s.split(Z).length-1);const ids=JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf(Z))).decisions.map(d=>d.id);const miss=[...Array(20)].map((_,n)=>"t-race-"+(n+1)).filter(x=>!ids.includes(x));if(miss.length)throw "lost: "+miss'
t 0 "race: no temp files or lock left"      test -z "$(ls "$(dirname "$AB_FILE")" | grep -E '\.tmp$|\.lock$')"
# Corrupt board (stale duplicate tail after END): raise refuses with exit 2 and no write; open/check report it.
C="$T/c/app/src/data/board.ts"; mkdir -p "$(dirname "$C")"; cp "$AB_FILE" "$C"; tail -c 300 "$AB_FILE" >> "$C"; SUM=$(cksum < "$C")
t 2 "corrupt board: raise refused"          env AB_FILE="$C" node "$AB" raise "$P"
t 0 "  ...error names the problem and file" bash -c "AB_FILE='$C' node '$AB' raise '$P' 2>&1 | grep -qF 'board is corrupt: 1 BOARD-JSON-START and 2 BOARD-JSON-END markers (need exactly one each) in $C'"
t 0 "  ...board.ts unchanged"               test "$(cksum < "$C")" = "$SUM"
t 1 "corrupt board: check exits 1"          env AB_FILE="$C" node "$AB" check
t 0 "  ...check lists it as a problem"      bash -c "AB_FILE='$C' node '$AB' check | grep -q 'board is corrupt: 1 BOARD-JSON-START and 2 BOARD-JSON-END'"
t 0 "  ...open lists it as a problem"       bash -c "AB_FILE='$C' node '$AB' open | grep -q 'board is corrupt'"
echo '/* BOARD-JSON-START */ {} /* BOARD-JSON-END */ ; export const x = 1' > "$C"
t 2 "text after END refused"                env AB_FILE="$C" node "$AB" lint
# Lock: a stale one (>30s) is cleared; a fresh held one makes the write wait, then succeed after release.
mkdir "$AB_FILE.lock"; node -e 'const t=Date.now()/1000-60;require("fs").utimesSync(process.argv[1],t,t)' "$AB_FILE.lock"
t 0 "stale lock cleared"                    bash -c "echo '{\"waiting\":[],\"tickets\":[]}' | node '$AB' glance"
t 0 "  ...and released after the write"     test ! -e "$AB_FILE.lock"
mkdir "$AB_FILE.lock"; (sleep 1; rmdir "$AB_FILE.lock") &
ms() { node -e 'console.log(Date.now())'; }; start=$(ms)
t 0 "held lock: write waits, then succeeds" bash -c "echo '{\"waiting\":[],\"tickets\":[]}' | node '$AB' glance"
t 0 "  ...after the lock was released (>=900ms)"  test $(( $(ms) - start )) -ge 900
wait
# Stamps: a new raise sets created_at and updated_at to the same instant ("added"); a re-raise keeps created_at and moves
# updated_at later; answer moves it again. updated_at is ab's to set, so raise refuses it as input.
dget() { node -e 'const s=require("fs").readFileSync(process.env.AB_FILE,"utf8");const A="/* BOARD-JSON-START */";const d=JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf("/* BOARD-JSON-END */"))).decisions.find(x=>x.id===process.argv[1]);console.log(!d?"MISSING":d[process.argv[2]]??"absent")' "$1" "$2"; }
iso() { node -e 'const v=process.argv[1];if(Number.isNaN(Date.parse(v))||!v.endsWith("Z"))process.exit(1)' "$1"; }
ST='{"id":"t-stamp","title":"Stamp card",'"$CTX"',"question":"Ship the stamp test card?","what_happens_after":"A.","options":[{"id":"a","label":"A"}]}'
t 0 "stamp: raise a new card"               node "$AB" raise "$ST"
C0=$(dget t-stamp created_at); U0=$(dget t-stamp updated_at)
t 0 "  ...created_at is ISO UTC"            iso "$C0"
t 0 "  ...updated_at equals created_at"     test "$U0" = "$C0"
t 0 "stamp: re-raise the open card"         node "$AB" raise "$ST"
U1=$(dget t-stamp updated_at)
t 0 "  ...keeps created_at"                 test "$(dget t-stamp created_at)" = "$C0"
t 0 "  ...sets a later updated_at"          node -e 'const [a,b]=process.argv.slice(1);if(!(Date.parse(b)>Date.parse(a)))process.exit(1)' "$U0" "$U1"
t 0 "stamp: answer"                         node "$AB" answer t-stamp a --by chat --at 2026-11-10T17:00:00.000Z
U2=$(dget t-stamp updated_at)
t 0 "  ...keeps created_at"                 test "$(dget t-stamp created_at)" = "$C0"
t 0 "  ...sets updated_at to now, later than the re-raise"  node -e 'const [a,b]=process.argv.slice(1);if(!(Date.parse(b)>Date.parse(a))||Date.now()-Date.parse(b)>60000)process.exit(1)' "$U1" "$U2"
SUM=$(cksum < "$AB_FILE")
t 2 "raise with updated_at input refused"   node "$AB" raise '{"id":"t-stamp2","title":"Stamp card two",'"$CTX"',"question":"Ship the second stamp card?","what_happens_after":"A.","options":[{"id":"a","label":"A"}],"updated_at":"2026-11-10T09:00:00.000Z"}'
t 0 "  ...error names updated_at"           bash -c "node '$AB' raise '{\"id\":\"t-stamp2\",\"updated_at\":\"x\"}' 2>&1 | grep -q '^ab: unknown field updated_at'"
t 0 "  ...board.ts unchanged"               test "$(cksum < "$AB_FILE")" = "$SUM"
# Re-raise of an open id updates the card in place: same slot, no duplicate, new text and labels, same option ids,
# created_at kept (even when the re-raise passes one), updated_at moved to now, stored and printed card have the new title.
dx() { node -e 'const s=require("fs").readFileSync(process.env.AB_FILE,"utf8");const A="/* BOARD-JSON-START */";const ds=JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf("/* BOARD-JSON-END */"))).decisions;const i=ds.findIndex(x=>x.id===process.argv[1]);console.log(JSON.stringify({n:ds.filter(x=>x.id===process.argv[1]).length,i,d:ds[i]}))' "$1"; }
IPCTX='"context":"In place test card standing in for a real ticket that needs a call."'
IP1='{"id":"t-inplace","title":"In place card",'"$IPCTX"',"question":"Ship the in place test card?","what_happens_after":"The assistant ships it.","options":[{"id":"go","label":"Go"},{"id":"hold","label":"Hold"}],"blocking":false}'
IP2='{"id":"t-inplace","title":"Reworded in place card","context":"Reworded context for the in place card, now saying plainly what changed and why.","question":"Ship the reworded in place test card today?","what_happens_after":"The assistant ships it today and posts a note.","options":[{"id":"go","label":"Ship it today"},{"id":"hold","label":"Hold until Monday"}],"blocking":false,"created_at":"2020-01-01T00:00:00.000Z"}'
nb() { echo '{"id":"'"$1"'","title":"In place neighbour '"$1"'",'"$IPCTX"',"question":"Ship the neighbour test card?","what_happens_after":"A.","options":[{"id":"a","label":"A"}],"blocking":false}'; }
t 0 "in place: raise a card between two others"  bash -c "node '$AB' raise '$(nb t-inplace-before)' >/dev/null && node '$AB' raise '$IP1' >/dev/null && node '$AB' raise '$(nb t-inplace-after)' >/dev/null"
B0=$(dx t-inplace)
t 0 "in place: re-raise with new title, text, labels, same option ids"  bash -c "node '$AB' raise '$IP2' > '$T/ip-card.json'"
B1=$(dx t-inplace)
ipcheck() { node -e 'const [a,b]=process.argv.slice(1,3).map(JSON.parse);const ok=eval(process.argv[3]);if(!ok){console.error(JSON.stringify({a,b}));process.exit(1)}' "$B0" "$B1" "$1"; }
t 0 "  ...one decision with that id"         ipcheck 'a.n===1&&b.n===1'
t 0 "  ...at the same index"                 ipcheck 'a.i>=0&&b.i===a.i'
t 0 "  ...question, context, what_happens_after written"  ipcheck 'b.d.question==="Ship the reworded in place test card today?"&&b.d.context.startsWith("Reworded context")&&b.d.what_happens_after==="The assistant ships it today and posts a note."'
t 0 "  ...option labels written, option ids identical"   ipcheck 'JSON.stringify(b.d.options.map(o=>o.label))==="[\"Ship it today\",\"Hold until Monday\"]"&&JSON.stringify(b.d.options.map(o=>o.id))===JSON.stringify(a.d.options.map(o=>o.id))'
t 0 "  ...new title stored, old one replaced"  ipcheck 'a.d.title==="In place card"&&b.d.title==="Reworded in place card"'
t 0 "  ...created_at unchanged (passed created_at ignored)"  ipcheck 'typeof a.d.created_at==="string"&&b.d.created_at===a.d.created_at'
t 0 "  ...updated_at changed, >= created_at, ~now"  ipcheck 'b.d.updated_at!==a.d.updated_at&&Date.parse(b.d.updated_at)>=Date.parse(b.d.created_at)&&Date.now()-Date.parse(b.d.updated_at)<60000'
t 0 "  ...printed card has the new title and text"  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).card;if(c.title!=="Reworded in place card"||c.question!=="Ship the reworded in place test card today?"||JSON.stringify(c.options)!=="[\"Ship it today\",\"Hold until Monday\"]"||c.decision_id!=="t-inplace")process.exit(1)' "$T/ip-card.json"
t 0 "  ...neighbours keep their places"      test "$(dx t-inplace-before | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).i)') $(dx t-inplace-after | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).i)')" = "$(( $(echo "$B1" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).i)') - 1 )) $(( $(echo "$B1" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).i)') + 1 ))"
t 0 "a new raise still takes a passed created_at"  bash -c "node '$AB' raise '$(nb t-inplace-new | sed 's/}$/,"created_at":"2026-11-01T08:00:00.000Z"}/')' >/dev/null && test \"\$(AB_FILE='$AB_FILE' node -e 'const s=require(\"fs\").readFileSync(process.env.AB_FILE,\"utf8\");const A=\"/* BOARD-JSON-START */\";const d=JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf(\"/* BOARD-JSON-END */\"))).decisions.find(x=>x.id===\"t-inplace-new\");console.log(d.created_at+\" \"+d.updated_at)')\" = '2026-11-01T08:00:00.000Z 2026-11-01T08:00:00.000Z'"
# Title on raise: stored trimmed as the first key after id; refusals exit 2 and leave board.ts alone.
TI='{"id":"t-title","title":"  Checkout guarded write merge order  ",'"$CTX"',"question":"Merge the checkout guarded write first?","what_happens_after":"A.","options":[{"id":"a","label":"A"}],"link":"https://example.com/pr/9"}'
t 0 "raise with a title"                    bash -c "node '$AB' raise '$TI' > '$T/ti-card.json'"
t 0 "  ...title stored trimmed, first key after id"  node -e 'const d=JSON.parse(process.argv[1]).d;if(d.title!=="Checkout guarded write merge order"||Object.keys(d).slice(0,2).join()!=="id,title"||!d.link)process.exit(1)' "$(dx t-title)"
t 0 "  ...shows in the stored JSON"         grep -qF '"title": "Checkout guarded write merge order"' "$AB_FILE"
t 0 "  ...printed card uses the same title" node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).card;if(c.title!=="Checkout guarded write merge order")process.exit(1)' "$T/ti-card.json"
SUM=$(cksum < "$AB_FILE")
tbad() { echo "$TI" | sed "s|\"title\":\"  Checkout guarded write merge order  \",|$1|;s|\"id\":\"t-title\"|\"id\":\"t-title-bad\"|"; }
t 2 "raise with a missing title refused"    node "$AB" raise "$(tbad '')"
t 0 "  ...error names title and gives an example"  bash -c "node '$AB' raise '$(tbad '')' 2>&1 | grep -qF 'ab: title is required: a short bold topic for the top of the card, for example \"Q3 vendor contract renewal\"'"
t 2 "raise with a blank title refused"      node "$AB" raise "$(tbad '"title":"   ",')"
t 2 "raise with a 61-char title refused"    node "$AB" raise "$(tbad '"title":"'"$(printf 'a%.0s' $(seq 61))"'",')"
t 0 "  ...error gives the length"           bash -c "node '$AB' raise '$(tbad '"title":"'"$(printf 'a%.0s' $(seq 61))"'",')' 2>&1 | grep -q '^ab: title is 61 chars; keep it to 60 or fewer'"
t 0 "a 60-char title is fine"               node "$AB" raise "$(echo "$TI" | sed "s|  Checkout guarded write merge order  |Checkout guarded write merge order $(printf 'a%.0s' $(seq 25))|")"
SUM=$(cksum < "$AB_FILE")
t 2 "raise with an id-only title refused"   node "$AB" raise "$(tbad '"title":"PROJ-15054 PR #12",')"
t 2 "raise with a multi-line title refused" node "$AB" raise "$(tbad '"title":"Checkout guarded\\nwrite merge order",')"
t 0 "  ...error says one line"              bash -c "node '$AB' raise '$(tbad '"title":"Checkout guarded\\nwrite merge order",')' 2>&1 | grep -q '^ab: title must be one line'"
t 2 "raise with a non-string title refused" node "$AB" raise "$(tbad '"title":["Checkout guarded write"],')"
t 0 "  ...title refusals leave board.ts unchanged"  test "$(cksum < "$AB_FILE")" = "$SUM"
TC0=$(dget t-title created_at)
t 0 "re-raise changes the title"            node "$AB" raise "$(echo "$TI" | sed 's|  Checkout guarded write merge order  |Checkout write merge order, reworded|')"
t 0 "  ...new title stored, created_at kept" test "$(dget t-title title) $(dget t-title created_at)" = "Checkout write merge order, reworded $TC0"
# backfill-titles: same title rules; sets only open cards without one; card stamps unchanged.
seed "[{\"id\":\"bt-a\",$ok,\"question\":\"Close the Address asterisk ticket?\",$base,\"updated_at\":\"2026-11-10T09:30:00.000Z\"},{\"id\":\"bt-has\",\"title\":\"Kept title here\",$ok,\"question\":\"Close the Address asterisk ticket?\",$base},{\"id\":\"bt-ans\",\"question\":\"Ship it?\",$base,$ans},{\"id\":\"bt-left\",$ok,\"question\":\"Close the Address asterisk ticket?\",$base}]"
SUM=$(cksum < "$AB_FILE"); LG="$T/app/.ab-log.jsonl"; LSUM=$(cksum < "$LG" 2>/dev/null)
t 2 "backfill-titles with an invalid title refused"  bash -c "echo '{\"bt-a\":\"Checkout guarded write\",\"bt-left\":\"PROJ-1\"}' | node '$AB' backfill-titles"
t 0 "  ...error names the id and title"     bash -c "echo '{\"bt-left\":\"PROJ-1\"}' | node '$AB' backfill-titles 2>&1 | grep -qF 'ab: bt-left: title: \"PROJ-1\" is only an id'"
t 2 "backfill-titles with a 61-char title refused"  bash -c "echo '{\"bt-a\":\"$(printf 'a%.0s' $(seq 61))\"}' | node '$AB' backfill-titles"
t 2 "backfill-titles with a non-object refused"  bash -c "echo '[\"bt-a\"]' | node '$AB' backfill-titles"
t 0 "  ...writes nothing (board, log)"      test "$(cksum < "$AB_FILE") $(cksum < "$LG" 2>/dev/null)" = "$SUM $LSUM"
BT0=$(dx bt-a)
t 0 "backfill-titles reports set, unknown, skipped, still missing"  bash -c "echo '{\"bt-a\":\" Address asterisk ticket \",\"bt-nope\":\"Unknown card title\",\"bt-ans\":\"Answered card title\",\"bt-has\":\"New title words\"}' | node '$AB' backfill-titles | node -e 'console.log(JSON.stringify(JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"))))' | grep -qxF '{\"ok\":true,\"wrote\":true,\"set\":[\"bt-a\"],\"unknown\":[\"bt-nope\"],\"skipped_answered\":[\"bt-ans\"],\"skipped_has_title\":[\"bt-has\"],\"still_missing\":[\"bt-left\"]}'"
BT1=$(dx bt-a)
t 0 "  ...title set trimmed, id then title first"  node -e 'const d=JSON.parse(process.argv[1]).d;if(d.title!=="Address asterisk ticket"||Object.keys(d).slice(0,2).join()!=="id,title")process.exit(1)' "$BT1"
t 0 "  ...updated_at and created_at unchanged, nothing else changed"  node -e 'const [a,b]=process.argv.slice(1).map(s=>JSON.parse(s).d);const {title,...r}=b;if(JSON.stringify(r)!==JSON.stringify(a)||b.updated_at!=="2026-11-10T09:30:00.000Z")process.exit(1)' "$BT0" "$BT1"
t 0 "  ...existing title kept"              test "$(dget bt-has title)" = "Kept title here"
t 0 "  ...answered card left without a title"  test "$(dget bt-ans title)" = "absent"
t 0 "  ...logs backfill-titles"             bash -c "tail -1 '$LG' | grep -q '\"op\":\"backfill-titles\",\"count\":1}'"
SUM=$(cksum < "$AB_FILE")
t 0 "backfill-titles with nothing to set writes nothing"  bash -c "echo '{\"bt-has\":\"Other title words\"}' | node '$AB' backfill-titles | grep -q '\"wrote\": false' && test \"\$(cksum < '$AB_FILE')\" = '$SUM'"
# backfill-stamps: a temp tree with its own board.ts and .ab-log.jsonl (two folders above board.ts).
BF="$T/bf/app/src/data/board.ts"; BL="$T/bf/app/.ab-log.jsonl"; mkdir -p "$(dirname "$BF")"; cp "$SRC" "$BF"
c='"created_at":"2026-11-10T09:00:00.000Z"'
AB_FILE="$BF" seed "[{\"id\":\"b-once\",$ok,\"question\":\"Close the Address asterisk ticket?\",\"card_ref\":null,\"what_happens_after\":\"A.\",\"options\":[{\"id\":\"a\",\"label\":\"A\"}],$c},
 {\"id\":\"b-later\",$ok,\"question\":\"Merge the checkout guard?\",\"card_ref\":\"PROJ-14382\",\"what_happens_after\":\"A.\",\"options\":[{\"id\":\"a\",\"label\":\"A\"}],$c,$ans},
 {\"id\":\"b-nocreated\",\"question\":\"Ship the billing banner?\",\"card_ref\":null,\"what_happens_after\":\"A.\",\"options\":[{\"id\":\"a\",\"label\":\"A\"}],\"details\":[\"One\"]},
 {\"id\":\"b-nolog\",\"question\":\"Ship the invoice export?\",\"card_ref\":null,\"what_happens_after\":\"A.\",\"options\":[{\"id\":\"a\",\"label\":\"A\"}]},
 {\"id\":\"b-has\",\"question\":\"Ship the chat alerts?\",\"card_ref\":null,\"what_happens_after\":\"A.\",\"options\":[{\"id\":\"a\",\"label\":\"A\"}],$c,\"updated_at\":\"2026-11-10T09:30:00.000Z\"},
 {\"id\":\"b-nologc\",\"question\":\"Ship the CRM sync?\",\"card_ref\":null,\"what_happens_after\":\"A.\",\"options\":[{\"id\":\"a\",\"label\":\"A\"}],$c}]"
cat > "$BL" <<'LOG'
{"at":"2026-11-10T09:00:00.300Z","op":"raise","id":"b-once","live":true}
{"at":"2026-11-10T09:00:00.310Z","op":"raise","id":"b-later","live":true}
not json at all
{"at":"2026-11-10T09:10:00.000Z","op":"glance","live":true}
{"at":"2026-11-10T10:00:00.000Z","op":"raise","id":"b-later","live":true}
{"at":"2026-11-11T08:00:00.300Z","op":"raise","id":"b-nocreated","live":true}
{"at":"not a time","op":"raise","id":"b-nolog","live":true}
{"at":"2026-11-10T11:00:00.000Z","op":"answer","id":"b-later","by":"chat","live":true}
{"at":"2026-11-10T12:00:00.000Z","op":"clear","id":"gone-1"}
{"at":"2026-11-12T08:00:00.000Z","op":"raise","id":"b-has","live":true}
LOG
# The board minus created_at/updated_at, to show backfill changes nothing else.
rest() { node -e 'const s=require("fs").readFileSync(process.env.AB_FILE,"utf8");const A="/* BOARD-JSON-START */";const b=JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf("/* BOARD-JSON-END */")));console.log(JSON.stringify([b.decisions.map(({created_at,updated_at,...r})=>r),b.glance]))'; }
REST=$(AB_FILE="$BF" rest); SUM=$(cksum < "$BF"); LSUM=$(cksum < "$BL")
want='"stamped":["b-once","b-later","b-nocreated"],"blank":["b-nolog"],"no_history":["b-nolog","b-nologc"],"unchanged":3,"counts":{"stamped":3,"blank":1,"no_history":2,"unchanged":3,"total":6}'
bfrun() { AB_FILE="$BF" node "$AB" backfill-stamps "$@" | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8"))))'; }
t 0 "backfill --dry-run reports what it would stamp"  bash -c "$(declare -f bfrun); AB='$AB' BF='$BF' bfrun --dry-run | grep -qF '{\"ok\":true,\"dry_run\":true,\"wrote\":false,$want}'"
t 0 "  ...and writes nothing (board, log)"  test "$(cksum < "$BF") $(cksum < "$BL")" = "$SUM $LSUM"
t 2 "backfill with an unknown argument refused"  env AB_FILE="$BF" node "$AB" backfill-stamps --force
t 0 "backfill stamps the board"             bash -c "$(declare -f bfrun); AB='$AB' BF='$BF' bfrun | grep -qF '{\"ok\":true,\"dry_run\":false,\"wrote\":true,$want}'"
bget() { AB_FILE="$BF" dget "$1" "$2"; }
t 0 "  ...one raise only: updated_at = created_at"      test "$(bget b-once created_at) $(bget b-once updated_at)" = "2026-11-10T09:00:00.000Z 2026-11-10T09:00:00.000Z"
t 0 "  ...later raise and answer: updated_at = latest"  test "$(bget b-later created_at) $(bget b-later updated_at)" = "2026-11-10T09:00:00.000Z 2026-11-10T11:00:00.000Z"
t 0 "  ...no created_at: first raise fills it"          test "$(bget b-nocreated created_at) $(bget b-nocreated updated_at)" = "2026-11-11T08:00:00.300Z 2026-11-11T08:00:00.300Z"
t 0 "  ...no log: left blank"                           test "$(bget b-nolog created_at) $(bget b-nolog updated_at)" = "absent absent"
t 0 "  ...existing updated_at kept"                     test "$(bget b-has updated_at)" = "2026-11-10T09:30:00.000Z"
t 0 "  ...created_at but no log: no invented updated_at"  test "$(bget b-nologc created_at) $(bget b-nologc updated_at)" = "2026-11-10T09:00:00.000Z absent"
t 0 "  ...every other field and the order unchanged"    test "$(AB_FILE="$BF" rest)" = "$REST"
t 0 "  ...logs backfill-stamps with the count"          bash -c "tail -1 '$BL' | grep -q '\"op\":\"backfill-stamps\",\"count\":3}'"
SUM=$(cksum < "$BF"); LSUM=$(cksum < "$BL")
t 0 "backfill again changes nothing"        bash -c "$(declare -f bfrun); AB='$AB' BF='$BF' bfrun | grep -qF '\"wrote\":false,\"stamped\":[],\"blank\":[\"b-nolog\"]'"
t 0 "  ...and does not write (board, log)"  test "$(cksum < "$BF") $(cksum < "$BL")" = "$SUM $LSUM"
rm "$BL"
t 0 "backfill without a log: all no_history, no write"  bash -c "$(declare -f bfrun); AB='$AB' BF='$BF' bfrun | grep -qF '\"no_history\":[\"b-once\",\"b-later\",\"b-nocreated\",\"b-nolog\",\"b-has\",\"b-nologc\"]'"
t 0 "  ...board unchanged, no log created"  test "$(cksum < "$BF")" = "$SUM" -a ! -e "$BL"
# Priority: raise takes an optional high|medium|low (absent = medium, never written by default); a re-raise without it
# keeps the stored one. ab priority sets only that field on an open card. open/check count open cards per level.
seed "[]"
PR() { echo '{"id":"'"$1"'","title":"Priority card '"$1"'",'"$CTX"',"question":"Ship the priority test card?","what_happens_after":"A.","options":[{"id":"a","label":"A"}]'"${2:-}"'}'; }
for lv in high low medium; do
  t 0 "priority: raise with $lv"            node "$AB" raise "$(PR t-p-$lv ',"priority":"'$lv'"')"
  t 0 "  ...stored as $lv"                  test "$(dget t-p-$lv priority)" = "$lv"
done
t 0 "priority: printed card carries it"     bash -c "node '$AB' raise '$(PR t-p-high)' | grep -q '\"priority\": \"high\"'"
t 0 "priority: re-raise without it keeps the stored one"  test "$(dget t-p-high priority)" = "high"
t 0 "priority: re-raise with it sets it"    bash -c "node '$AB' raise '$(PR t-p-high ',"priority":"low"')' >/dev/null"
t 0 "  ...now low"                          test "$(dget t-p-high priority)" = "low"
t 0 "priority: raise without it"            bash -c "node '$AB' raise '$(PR t-p-none)' | grep -q '\"priority\": \"medium\"'"
t 0 "  ...stores no priority field"         test "$(dget t-p-none priority)" = "absent"
SUM=$(cksum < "$AB_FILE")
for bad in '"urgent"' '"HIGH"' '" high"' '""' '1' 'null' 'true' '["high"]' '{}'; do
  t 2 "priority: raise with $bad refused"   node "$AB" raise "$(PR t-p-bad ',"priority":'"$bad")"
done
t 0 "  ...error says why"                   bash -c "node '$AB' raise '$(PR t-p-bad ',"priority":"urgent"')' 2>&1 | grep -qx 'ab: priority must be high, medium or low'"
t 2 "  ...also on a re-raise"               node "$AB" raise "$(PR t-p-none ',"priority":"top"')"
t 0 "  ...board.ts unchanged"               test "$(cksum < "$AB_FILE")" = "$SUM"
# ab priority: the board minus the target's priority and the board's own updated_at must not change.
pick() { node -e 'const s=require("fs").readFileSync(process.env.AB_FILE,"utf8");const A="/* BOARD-JSON-START */";const b=JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf("/* BOARD-JSON-END */")));for(const d of b.decisions)if(d.id===process.argv[1])delete d.priority;delete b.updated_at;console.log(JSON.stringify(b))' "$1"; }
REST=$(pick t-p-none); U=$(dget t-p-none updated_at)
t 0 "ab priority: prints ok, the level and was"  bash -c "node '$AB' priority t-p-none high | grep -qxF '{\"ok\":true,\"id\":\"t-p-none\",\"priority\":\"high\",\"was\":\"medium\",\"live\":true}'"
t 0 "  ...stored high"                      test "$(dget t-p-none priority)" = "high"
t 0 "  ...nothing else changed (other cards, this card's other fields)"  test "$(pick t-p-none)" = "$REST"
t 0 "  ...card updated_at unchanged"        test "$(dget t-p-none updated_at)" = "$U"
t 0 "  ...logged"                           bash -c "tail -1 '$T/app/.ab-log.jsonl' | grep -q '\"op\":\"priority\",\"id\":\"t-p-none\",\"priority\":\"high\"}'"
t 0 "ab priority: same level is a no-op ok" bash -c "node '$AB' priority t-p-none high | grep -q '\"priority\":\"high\",\"was\":\"high\"'"
t 0 "ab priority: medium stored explicitly" bash -c "node '$AB' priority t-p-none medium >/dev/null && test \"\$(AB_FILE='$AB_FILE' node -e 'const s=require(\"fs\").readFileSync(process.env.AB_FILE,\"utf8\");const A=\"/* BOARD-JSON-START */\";console.log(JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf(\"/* BOARD-JSON-END */\"))).decisions.find(x=>x.id===\"t-p-none\").priority)')\" = medium"
t 0 "  ...re-raise without priority keeps it"  bash -c "node '$AB' raise '$(PR t-p-none)' >/dev/null"
t 0 "  ...still medium"                     test "$(dget t-p-none priority)" = "medium"
node "$AB" answer t-p-medium a --by chat >/dev/null
SUM=$(cksum < "$AB_FILE")
t 2 "ab priority: invalid level"            node "$AB" priority t-p-none urgent
t 0 "  ...usage error"                      bash -c "node '$AB' priority t-p-none urgent 2>&1 | grep -qxF 'ab: usage: ab priority <id> <high|medium|low>'"
t 2 "ab priority: missing level"            node "$AB" priority t-p-none
t 2 "ab priority: missing id and level"     node "$AB" priority
t 2 "ab priority: extra argument"           node "$AB" priority t-p-none high low
t 5 "ab priority: unknown id"               node "$AB" priority t-p-never high
t 0 "  ...says so"                          bash -c "node '$AB' priority t-p-never high 2>&1 | grep -qxF 'ab: no decision t-p-never on the board'"
t 4 "ab priority: answered id"              node "$AB" priority t-p-medium high
t 0 "  ...says so"                          bash -c "node '$AB' priority t-p-medium high 2>&1 | grep -qxF 'ab: t-p-medium is already answered'"
t 0 "ab priority refusals leave board.ts unchanged"  test "$(cksum < "$AB_FILE")" = "$SUM"
# open/check: open cards only (t-p-medium is answered), a missing priority counts as medium.
seed "[{\"id\":\"o-none\",$ok,\"question\":\"Ship the invoice export?\",$base},{\"id\":\"o-high\",$ok,\"question\":\"Ship the CRM sync?\",$base,\"priority\":\"high\"},{\"id\":\"o-low\",$ok,\"question\":\"Ship the billing banner?\",$base,\"priority\":\"low\"},{\"id\":\"o-low2\",$ok,\"question\":\"Ship the chat alerts?\",$base,\"priority\":\"low\"},{\"id\":\"o-ans\",$ok,\"question\":\"Ship the audit log?\",$base,\"priority\":\"high\",$ans}]"
popen() { node "$AB" "$1" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(JSON.stringify([r.priority_open,r.open_priority]))'; }
WANT='[{"high":1,"medium":1,"low":2},[{"id":"o-none","priority":"medium","blocking":null,"blocks":null},{"id":"o-high","priority":"high","blocking":null,"blocks":null},{"id":"o-low","priority":"low","blocking":null,"blocks":null},{"id":"o-low2","priority":"low","blocking":null,"blocks":null}]]'
t 0 "open: priority_open and open_priority"   test "$(popen open)" = "$WANT"
t 0 "check: priority_open and open_priority"  test "$(popen check)" = "$WANT"
C2="$T/c2/app/src/data/board.ts"; mkdir -p "$(dirname "$C2")"; cp "$AB_FILE" "$C2"; tail -c 300 "$AB_FILE" >> "$C2"
t 0 "corrupt board: priority_open and open_priority are null"  bash -c "AB_FILE='$C2' node '$AB' open | node -e 'const r=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));if(r.counts!==null||r.priority_open!==null||r.open_priority!==null)process.exit(1)'"
# Blocking: raise requires a boolean blocking; true forces high (a passed medium or low is refused, a re-raise upgrades).
# ab priority keeps a blocking card high. check and lint flag an open blocking card that is not high; no blocking = unknown.
seed "[]"
BL=',"blocks":"PR #11461 hired application guard merge"'
BK() { echo '{"id":"'"$1"'","title":"Blocking card '"$1"'","context":"Blocking test card standing in for a merge that waits on a call from the user.","question":"Merge the blocking test card?","what_happens_after":"A.","options":[{"id":"a","label":"A"}]'"${2:-}"'}'; }
cp "$AB_FILE" "$T/bk.before"
t 2 "blocking: raise without it refused"      node "$AB" raise "$(BK t-b-none)"
t 0 "  ...error says what blocking means"     bash -c "node '$AB' raise '$(BK t-b-none)' 2>&1 | grep -qxF 'ab: blocking is required: true only if a named open PR, merge or task cannot move until this is answered, and then blocks names it; else false'"
for bad in 'null' '"true"' '1' '"yes"' '[]'; do
  t 2 "blocking: $bad refused"                node "$AB" raise "$(BK t-b-bad ',"blocking":'"$bad")"
done
t 2 "blocking:true with priority medium refused"  node "$AB" raise "$(BK t-b-med ',"blocking":true,"priority":"medium"'"$BL")"
t 2 "blocking:true with priority low refused"     node "$AB" raise "$(BK t-b-low ',"blocking":true,"priority":"low"'"$BL")"
t 0 "  ...error says blocking cards are high"     bash -c "node '$AB' raise '$(BK t-b-low ',"blocking":true,"priority":"low"'"$BL")' 2>&1 | grep -q '^ab: blocking cards are always high priority'"
t 0 "  ...blocking refusals leave board.ts byte-identical"  cmp -s "$AB_FILE" "$T/bk.before"
t 0 "blocking:true without priority raised"   bash -c "node '$AB' raise '$(BK t-b-real ',"blocking":true'"$BL")' > '$T/bk-card.json'"
t 0 "  ...stored high (was medium before blocking existed)"  [ "$(dget t-b-real priority) $(dget t-b-real blocking)" = "high true" ]
t 0 "  ...printed card says high and blocking"  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).card;if(c.priority!=="high"||c.blocking!==true)process.exit(1)' "$T/bk-card.json"
t 0 "blocking:true with priority high raised" node "$AB" raise "$(BK t-b-high ',"blocking":true,"priority":"high"'"$BL")"
t 0 "  ...stored high"                        [ "$(dget t-b-high priority)" = high ]
t 0 "blocking:false without priority raised"  bash -c "node '$AB' raise '$(BK t-b-free ',"blocking":false')' | grep -q '\"blocking\": false'"
t 0 "  ...no priority stored, blocking false" [ "$(dget t-b-free priority) $(dget t-b-free blocking)" = "absent false" ]
t 0 "re-raise blocking:true of a medium card" bash -c "node '$AB' raise '$(BK t-b-free ',"blocking":false,"priority":"medium"')' >/dev/null && node '$AB' raise '$(BK t-b-free ',"blocking":true'"$BL")' >/dev/null"
t 0 "  ...upgraded to high"                   [ "$(dget t-b-free priority) $(dget t-b-free blocking)" = "high true" ]
t 0 "re-raise blocking:false without priority" node "$AB" raise "$(BK t-b-high ',"blocking":false')"
t 0 "  ...keeps the stored high"              [ "$(dget t-b-high priority) $(dget t-b-high blocking)" = "high false" ]
cp "$AB_FILE" "$T/bk.before"
t 2 "ab priority low on a blocking card refused"     node "$AB" priority t-b-real low
t 2 "ab priority medium on a blocking card refused"  node "$AB" priority t-b-real medium
t 0 "  ...says blocking cards stay high"      bash -c "node '$AB' priority t-b-real low 2>&1 | grep -qxF 'ab: t-b-real is a blocking card; blocking cards stay high'"
t 0 "  ...board.ts byte-identical"            cmp -s "$AB_FILE" "$T/bk.before"
t 0 "ab priority high on a blocking card is fine"    node "$AB" priority t-b-real high
t 0 "ab priority low on a card no longer blocking"   node "$AB" priority t-b-high low
KQ="$tt,$ok,\"question\":\"Close the Address asterisk ticket?\",$base"
KS="{\"id\":\"k-old\",$KQ},{\"id\":\"k-ok\",$KQ,\"blocking\":true,\"priority\":\"high\"$BL},{\"id\":\"k-free\",$KQ,\"blocking\":false,\"priority\":\"low\"},{\"id\":\"k-ans\",$KQ,\"blocking\":true,\"priority\":\"low\",$ans}"
seed "[$KS]"
t 0 "check: old card without blocking passes" node "$AB" check
t 0 "lint: old card without blocking passes"  node "$AB" lint
t 0 "open lists blocking per open card (null when unknown)"  [ "$(node "$AB" open | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).open_priority))')" = '[{"id":"k-old","priority":"medium","blocking":null,"blocks":null},{"id":"k-ok","priority":"high","blocking":true,"blocks":"PR #11461 hired application guard merge"},{"id":"k-free","priority":"low","blocking":false,"blocks":null}]' ]
seed "[$KS,{\"id\":\"k-bad\",$KQ,\"blocking\":true,\"priority\":\"medium\"$BL},{\"id\":\"k-nopri\",$KQ,\"blocking\":true$BL}]"
t 1 "check: hand-edited blocking card at medium flagged"  node "$AB" check
t 0 "  ...problems name both cards"           bash -c "node '$AB' check | node -e 'const r=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));if(JSON.stringify(r.problems)!==JSON.stringify([\"blocking is true but priority is medium; blocking cards must be high (fix with ab priority k-bad high)\",\"blocking is true but priority is medium; blocking cards must be high (fix with ab priority k-nopri high)\"]))process.exit(1)'"
t 1 "lint: hand-edited blocking card at medium flagged"   node "$AB" lint
t 0 "  ...k-bad and k-nopri fail, old, high, free and answered do not"  [ "$(node "$AB" lint | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).failing.map(x=>x.id).join())')" = "k-bad,k-nopri" ]
# Blocks: a blocking card names the in-flight work it holds up. raise requires it with blocking:true (1 to 200 chars after
# trim) and refuses it with blocking:false; a re-raise with blocking:false drops it. check and lint flag a blocking card
# without it. check also flags more than AB_MAX_HIGH (default 10) open high cards.
seed "[]"
cp "$AB_FILE" "$T/bs.before"
t 2 "blocks: blocking:true without blocks refused"   node "$AB" raise "$(BK t-s-none ',"blocking":true')"
t 0 "  ...error names the definition in one line"    bash -c "node '$AB' raise '$(BK t-s-none ',"blocking":true')' 2>&1 | grep -qxF 'ab: blocking:true needs \"blocks\" (1 to 200 chars) naming the work it blocks: a card is blocking only when a named piece of in-flight work (a specific open PR, merge or task being actively driven) cannot move until the user answers'"
for bad in '""' '"   "' '11461' '"'"$(printf 'x%.0s' $(seq 201))"'"'; do
  t 2 "blocks: ${bad:0:12} refused"                  node "$AB" raise "$(BK t-s-bad ',"blocking":true,"blocks":'"$bad")"
  t 0 "  ...says blocks needs 1 to 200 chars"        bash -c "node '$AB' raise '$(BK t-s-bad ',"blocking":true,"blocks":'"$bad")' 2>&1 | grep -q '^ab: blocking:true needs \"blocks\" (1 to 200 chars)'"
done
t 2 "blocks with blocking:false refused"             node "$AB" raise "$(BK t-s-free ',"blocking":false'"$BL")"
t 0 "  ...error says blocks is only for blocking cards"  bash -c "node '$AB' raise '$(BK t-s-free ',"blocking":false'"$BL")' 2>&1 | grep -q '^ab: blocks is only for blocking:true cards: a card is blocking only when'"
t 0 "  ...blocks refusals leave board.ts byte-identical"  cmp -s "$AB_FILE" "$T/bs.before"
t 0 "blocks: 200 chars with padding raised"          node "$AB" raise "$(BK t-s-max ',"blocking":true,"blocks":"  '"$(printf 'y%.0s' $(seq 200))"'  "')"
t 0 "  ...stored trimmed"                            [ "$(dget t-s-max blocks)" = "$(printf 'y%.0s' $(seq 200))" ]
t 0 "blocks: valid blocking raise"                   bash -c "node '$AB' raise '$(BK t-s-ok ',"blocking":true,"blocks":" PR #11461 hired application guard merge "')' > '$T/bs-card.json'"
t 0 "  ...stored on the card"                        [ "$(dget t-s-ok blocks)" = "PR #11461 hired application guard merge" ]
t 0 "  ...printed on the card"                       node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).card;if(c.blocks!=="PR #11461 hired application guard merge")process.exit(1)' "$T/bs-card.json"
t 0 "  ...listed in open"                            [ "$(node "$AB" open | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).open_priority.find(x=>x.id==="t-s-ok").blocks)')" = "PR #11461 hired application guard merge" ]
t 0 "blocking:false raise prints blocks null"        bash -c "node '$AB' raise '$(BK t-s-plain ',"blocking":false')' | grep -q '\"blocks\": null'"
t 0 "re-raise blocking:false drops blocks"           node "$AB" raise "$(BK t-s-ok ',"blocking":false')"
t 0 "  ...blocks gone, blocking false"               [ "$(dget t-s-ok blocks) $(dget t-s-ok blocking)" = "absent false" ]
t 0 "  ...open shows blocks null"                    [ "$(node "$AB" open | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).open_priority.find(x=>x.id==="t-s-ok").blocks)')" = "null" ]
seed "[$KS,{\"id\":\"k-noblk\",$KQ,\"blocking\":true,\"priority\":\"high\"},{\"id\":\"k-blank\",$KQ,\"blocking\":true,\"priority\":\"high\",\"blocks\":\"  \"}]"
t 1 "check: hand-edited blocking card without blocks flagged"  node "$AB" check
t 0 "  ...problems name both cards"                  bash -c "node '$AB' check | node -e 'const r=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));if(JSON.stringify(r.problems)!==JSON.stringify([\"blocking is true but blocks is empty: name the in-flight work it holds up, or raise k-noblk again with blocking:false\",\"blocking is true but blocks is empty: name the in-flight work it holds up, or raise k-blank again with blocking:false\"]))process.exit(1)'"
t 1 "lint: hand-edited blocking card without blocks flagged"   node "$AB" lint
t 0 "  ...only k-noblk and k-blank fail"             [ "$(node "$AB" lint | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).failing.map(x=>x.id).join())')" = "k-noblk,k-blank" ]
hs() { local n=$1 out="" i; for i in $(seq "$n"); do out="$out{\"id\":\"h-$i\",$KQ,\"priority\":\"high\"},"; done; echo "[$out{\"id\":\"h-low\",$KQ,\"priority\":\"low\"},{\"id\":\"h-ans\",$KQ,\"priority\":\"high\",$ans}]"; }
seed "$(hs 10)"
t 0 "check: 10 open high cards pass"                 node "$AB" check
seed "$(hs 11)"
t 1 "check: 11 open high cards flagged"              node "$AB" check
t 0 "  ...says so"                                   bash -c "node '$AB' check | node -e 'const r=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));if(JSON.stringify(r.problems)!==JSON.stringify([\"11 open cards are high (limit 10): a flood of high cards hides the real blockers\"]))process.exit(1)'"
t 0 "  ...lint does not count high cards"            node "$AB" lint
t 0 "AB_MAX_HIGH=20 lets 11 pass"                    env AB_MAX_HIGH=20 node "$AB" check
t 1 "AB_MAX_HIGH=5 flags 11"                         env AB_MAX_HIGH=5 node "$AB" check
for bad in 0 -3 1.5 ten ""; do
  t 2 "AB_MAX_HIGH='$bad' refused"                   env AB_MAX_HIGH="$bad" node "$AB" check
done
# Clear keeps the removed card in the tombstone; ab restore puts it back at the end and lets raise use the id again.
TB="$T/app/.ab-cleared.jsonl"
seed "[{\"id\":\"r-first\",$ok,\"question\":\"Ship the invoice export?\",$base},{\"id\":\"r-gone\",$ok,\"question\":\"Ship the CRM sync?\",$base,\"priority\":\"high\",\"details\":[\"One\"],\"updated_at\":\"2026-11-10T09:30:00.000Z\"},{\"id\":\"r-last\",$ok,\"question\":\"Ship the billing banner?\",$base}]"
DGONE=$(dx r-gone | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).d))')
others() { node -e 'const s=require("fs").readFileSync(process.env.AB_FILE,"utf8");const A="/* BOARD-JSON-START */";console.log(JSON.stringify(JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf("/* BOARD-JSON-END */"))).decisions.filter(d=>d.id!=="r-gone")))'; }
OTHERS=$(others)
t 0 "clear prints the same output as before"  bash -c "node '$AB' clear r-gone --reason 'not relevant' | grep -qxF '{\"ok\":true,\"status\":\"cleared\",\"id\":\"r-gone\"}'"
t 0 "  ...card gone from the board"          test "$(dget r-gone id)" = "MISSING"
t 0 "  ...other cards unchanged"             test "$(others)" = "$OTHERS"
tlast() { tail -1 "$TB" | node -e 'const t=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(JSON.stringify(eval(process.argv[1])))' "$1"; }
t 0 "  ...tombstone keeps the card as it was"  test "$(tlast t.card)" = "$DGONE"
t 0 "  ...tombstone reason is exactly 'not relevant'"  test "$(tlast t.reason)" = '"not relevant"'
t 0 "  ...tombstone keys id, reason, at, card"  test "$(tlast 'Object.keys(t)')" = '["id","reason","at","card"]'
t 4 "raise of the cleared id refused before restore"  node "$AB" raise "$(PR r-gone)"
t 5 "restore unknown id"                     node "$AB" restore r-never
t 0 "  ...says so"                           bash -c "node '$AB' restore r-never 2>&1 | grep -qxF 'ab: nothing to restore for r-never'"
t 2 "restore without an id"                  node "$AB" restore
t 0 "restore prints ok"                      bash -c "node '$AB' restore r-gone | grep -qxF '{\"ok\":true,\"status\":\"restored\",\"id\":\"r-gone\"}'"
t 0 "  ...card back at the end, identical"   test "$(dx r-gone)" = "{\"n\":1,\"i\":2,\"d\":$DGONE}"
t 0 "  ...other cards unchanged"             test "$(others)" = "$OTHERS"
t 0 "  ...restore marker appended"           test "$(tlast '[t.id,t.restored,Object.keys(t)]')" = '["r-gone",true,["id","restored","at"]]'
t 0 "  ...logged"                            bash -c "tail -1 '$T/app/.ab-log.jsonl' | grep -q '\"op\":\"restore\",\"id\":\"r-gone\"}'"
t 4 "restore twice refused (already on the board)"  node "$AB" restore r-gone
t 0 "  ...says so"                           bash -c "node '$AB' restore r-gone 2>&1 | grep -qxF 'ab: r-gone is already on the board'"
t 0 "raise of the restored id allowed"       bash -c "node '$AB' raise '$(PR r-gone)' >/dev/null"
node "$AB" clear r-gone --reason "test" >/dev/null; node "$AB" restore r-gone >/dev/null
t 0 "clear then restore again works (latest snapshot)"  test "$(dget r-gone question)" = "Ship the priority test card?"
node "$AB" answer r-last a --by chat >/dev/null; node "$AB" clear r-last --reason "done" >/dev/null
t 0 "restore of an answered card drops the answer"  bash -c "node '$AB' restore r-last >/dev/null && test \"\$(AB_FILE='$AB_FILE' node -e 'const s=require(\"fs\").readFileSync(process.env.AB_FILE,\"utf8\");const A=\"/* BOARD-JSON-START */\";const d=JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf(\"/* BOARD-JSON-END */\"))).decisions.find(x=>x.id===\"r-last\");console.log(\"answer\" in d)')\" = false"
echo '{"id":"r-old","reason":"old style","at":"2026-11-01T00:00:00.000Z"}' >> "$TB"
SUM=$(cksum < "$AB_FILE")
t 4 "restore of an old tombstone without a card refused"  node "$AB" restore r-old
t 0 "  ...says so"                           bash -c "node '$AB' restore r-old 2>&1 | grep -qxF 'ab: r-old was cleared without a saved card; it cannot be restored'"
t 4 "raise of an old-style tombstoned id still refused"  node "$AB" raise "$(PR r-old)"
t 0 "  ...board.ts unchanged"                test "$(cksum < "$AB_FILE")" = "$SUM"
# project-refresh: rewrites the milestones in the temp project.ts (AB_PROJECT_FILE), never the real one.
pget() { node -e 'const s=require("fs").readFileSync(process.env.AB_PROJECT_FILE,"utf8");const A="/* PROJECT-JSON-START */";const p=JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf("/* PROJECT-JSON-END */")));console.log(JSON.stringify(eval(process.argv[1])))' "$1"; }
PSEED=$(pget '({updated_at:p.updated_at,milestones:p.milestones.map(({id,done,in_progress,left,total})=>({id,done,in_progress,left,total}))})')
PORIG=$(cksum < "$AB_PROJECT_FILE")
cp "$AB_PROJECT_FILE" "$T/project.seed"
t 0 "project-refresh seed counts"        bash -c "node '$AB' project-refresh '$PSEED' | grep -qxF '{\"ok\":true,\"milestones\":4,\"totals\":{\"done\":23,\"in_progress\":4,\"left\":21,\"total\":44},\"updated_at\":\"2026-11-23T18:35:00.000Z\"}'"
t 0 "  ...round-trips project.ts byte for byte"  test "$(cksum < "$AB_PROJECT_FILE")" = "$PORIG"
t 0 "project-refresh JSON on stdin with -"       bash -c "echo '$PSEED' | node '$AB' project-refresh - | grep -q '\"milestones\":4'"
t 0 "project-refresh JSON on stdin, no arg"      bash -c "echo '$PSEED' | node '$AB' project-refresh | grep -q '\"milestones\":4'"
t 0 "project-refresh valid update"       node "$AB" project-refresh '{"updated_at":"2026-11-24T14:00:00-05:00","milestones":[{"id":"PROJ-102","done":10,"in_progress":1,"left":5,"total":15},{"id":"PROJ-101","done":12,"in_progress":0,"left":0,"total":12},{"id":"PROJ-105","key":"M5","title":"Post launch fixes","url":"https://example.com/tickets/PROJ-105","done":0,"in_progress":0,"left":4,"total":4}]}'
t 0 "  ...milestones in input order, known title and url kept"  test "$(pget 'p.milestones.map(m=>[m.key,m.id,m.title,m.url,m.done,m.left])')" = '[["M2","PROJ-102","Build the new pages","https://example.com/tickets/PROJ-102",10,5],["M1","PROJ-101","Design and content","https://example.com/tickets/PROJ-101",12,0],["M5","PROJ-105","Post launch fixes","https://example.com/tickets/PROJ-105",0,4]]'
t 0 "  ...updated_at stored as UTC, title and parent kept"  test "$(pget '[p.updated_at,p.title,p.parent.id]')" = '["2026-11-24T19:00:00.000Z","Website relaunch","PROJ-100"]'
t 0 "  ...updated_at defaults to now"     bash -c "node '$AB' project-refresh '{\"milestones\":[{\"id\":\"PROJ-101\",\"done\":1,\"in_progress\":0,\"left\":0,\"total\":1}]}' | node -e 'const r=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));if(Math.abs(Date.parse(r.updated_at)-Date.now())>60000)process.exit(1)'"
t 0 "project-refresh sets title and parent"  node "$AB" project-refresh '{"title":"Mobile app beta","parent":{"id":"APP-1","url":"https://example.com/tickets/APP-1"},"milestones":[{"id":"PROJ-101","done":1,"in_progress":0,"left":0,"total":1}]}'
t 0 "  ...stored first, before updated_at"  test "$(pget '[Object.keys(p).join(),p.title,p.parent.url]')" = '["title,updated_at,parent,milestones","Mobile app beta","https://example.com/tickets/APP-1"]'
cp "$T/project.seed" "$AB_PROJECT_FILE"
PSUM=$(cksum < "$AB_PROJECT_FILE")
pr() { node "$AB" project-refresh "$1"; }
perr() { node "$AB" project-refresh "$1" 2>&1 | grep -qF "$2"; }
M='"id":"PROJ-101"'
t 2 "project bad sums refused"           pr '{"milestones":[{'"$M"',"done":17,"in_progress":0,"left":1,"total":19}]}'
t 0 "  ...says why"                      perr '{"milestones":[{'"$M"',"done":17,"in_progress":0,"left":1,"total":19}]}' 'ab: project-refresh: milestones[0] (PROJ-101): done + left (17 + 1 = 18) must equal total (19)'
t 2 "project in_progress > left refused" pr '{"milestones":[{'"$M"',"done":10,"in_progress":3,"left":2,"total":12}]}'
t 0 "  ...says why"                      perr '{"milestones":[{'"$M"',"done":10,"in_progress":3,"left":2,"total":12}]}' 'ab: project-refresh: milestones[0] (PROJ-101): in_progress (3) must not exceed left (2)'
t 2 "project duplicate id refused"       pr '{"milestones":[{'"$M"',"done":1,"in_progress":0,"left":0,"total":1},{'"$M"',"done":1,"in_progress":0,"left":0,"total":1}]}'
t 0 "  ...says why"                      perr '{"milestones":[{'"$M"',"done":1,"in_progress":0,"left":0,"total":1},{'"$M"',"done":1,"in_progress":0,"left":0,"total":1}]}' 'ab: project-refresh: milestones[1] (PROJ-101) is a duplicate id'
t 2 "project bad JSON refused"           pr '{"milestones":['
t 0 "  ...says why"                      perr '{"milestones":[' 'ab: project-refresh: input is not valid JSON'
t 2 "project empty milestones refused"   pr '{"milestones":[]}'
t 2 "project id with a space refused"    pr '{"milestones":[{"id":"PROJ 101","done":1,"in_progress":0,"left":0,"total":1}]}'
t 2 "project negative count refused"     pr '{"milestones":[{'"$M"',"done":-1,"in_progress":0,"left":2,"total":1}]}'
t 2 "project fractional count refused"   pr '{"milestones":[{'"$M"',"done":0.5,"in_progress":0,"left":0.5,"total":1}]}'
t 2 "project string count refused"       pr '{"milestones":[{'"$M"',"done":"1","in_progress":0,"left":0,"total":1}]}'
t 2 "project missing count refused"      pr '{"milestones":[{'"$M"',"done":1,"left":0,"total":1}]}'
t 2 "project unknown key refused"        pr '{"milestones":[{'"$M"',"done":1,"in_progress":0,"left":0,"total":1,"canceled":2}]}'
t 2 "project new id without url refused" pr '{"milestones":[{"id":"PROJ-19002","key":"M9","title":"Later","done":1,"in_progress":0,"left":0,"total":1}]}'
t 0 "  ...says what a new id needs"      perr '{"milestones":[{"id":"PROJ-19002","key":"M9","title":"Later","done":1,"in_progress":0,"left":0,"total":1}]}' 'is new: give its key (like "M5"), title and url'
t 2 "project bad updated_at refused"     pr '{"updated_at":"yesterday","milestones":[{'"$M"',"done":1,"in_progress":0,"left":0,"total":1}]}'
t 2 "project blank title refused"        pr '{"title":" ","milestones":[{'"$M"',"done":1,"in_progress":0,"left":0,"total":1}]}'
t 2 "project parent without url refused" pr '{"parent":{"id":"X-1"},"milestones":[{'"$M"',"done":1,"in_progress":0,"left":0,"total":1}]}'
t 2 "project unknown top-level key refused"  pr '{"name":"X","milestones":[{'"$M"',"done":1,"in_progress":0,"left":0,"total":1}]}'
t 2 "project extra argument refused"     node "$AB" project-refresh "$PSEED" extra
t 0 "project refusals leave project.ts unchanged"  test "$(cksum < "$AB_PROJECT_FILE")" = "$PSUM"
t 0 "  ...and leave no temp or lock files"  test -z "$(ls "$T/app/src/data" | grep -v '^board.ts$' | grep -v '^project.ts$')"
echo 'export const project = {};' > "$AB_PROJECT_FILE"
t 2 "project file without markers refused"  pr "$PSEED"
cp "$T/project.seed" "$AB_PROJECT_FILE"
t 0 "check still passes after project-refresh"  node "$AB" check

L1="https://github.com/acme/example-api/pull/11764"; L2="https://github.com/acme/example-api/pull/11800"
W1='{"title":"Dashboard analytics","who":"Waiting for re-review","link":"'"$L1"'","base":"project","head":"PROJ-1-analytics"}'
O1='{"title":"Pricing tiers","author":"bob","who":"Your review requested","link":"'"$L2"'","base":"main","head":"hotfix/pricing"}'
glance() { printf '%s' "$1" | node "$AB" glance; }
gfield() { node -e 'const s=require("fs").readFileSync(process.env.AB_FILE,"utf8"),a="/* BOARD-JSON-START */",g=JSON.parse(s.slice(s.indexOf(a)+a.length,s.indexOf("/* BOARD-JSON-END */"))).glance; console.log(JSON.stringify(eval(process.argv[1])))' "$1"; }
t 0 "glance with base, head on PR items"   glance '{"waiting":['"$W1"'],"tickets":[],"others":['"$O1"']}'
t 0 "  ...stored as given"                 test "$(gfield '[g.waiting[0].base,g.waiting[0].head,g.others[0].base,"hot" in g.others[0]]')" = '["project","PROJ-1-analytics","main",false]'
# Explicit HOT toggles: ab hot / ab unhot [--by name] write the board's hot map (keyed by the canonical PR URL), the
# glance PRs with that link, and one line per real change to the event log ($AB_EVENTS_FILE).
L3="https://github.com/acme/example-web/pull/11900"; L4="https://github.com/acme/example-api/pull/12001"
W3='{"title":"Dark mode","who":"CI","link":"'"$L3"'"}'
node -e 'const fs=require("fs"),f=process.env.AB_FILE,s=fs.readFileSync(f,"utf8"),A="/* BOARD-JSON-START */",i=s.indexOf(A)+A.length,j=s.indexOf("/* BOARD-JSON-END */");const b=JSON.parse(s.slice(i,j));delete b.hot;fs.writeFileSync(f,s.slice(0,i)+"\n"+JSON.stringify(b,null,2)+"\n"+s.slice(j))'
OUT="$T/out.json"; EV="$AB_EVENTS_FILE"
abo() { node "$AB" "$@" > "$OUT"; }
okj() { node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8"));if(eval(process.argv[1])!==true){console.error(JSON.stringify(r));process.exit(1)}' "$1" "$OUT"; }
# hget EXPR URL: EXPR over m = board.hot[URL] (and b, the board).
hget() { node -e 'const s=require("fs").readFileSync(process.env.AB_FILE,"utf8");const A="/* BOARD-JSON-START */";const b=JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf("/* BOARD-JSON-END */")));const m=(b.hot||{})[process.argv[2]];console.log(JSON.stringify(eval(process.argv[1])))' "$1" "$2"; }
evn() { if [ -f "$EV" ]; then wc -l < "$EV" | tr -d ' '; else echo 0; fi; }
# evchk N KIND URL BY: the log has N lines and the last is exactly {at,kind,url,by} with an ISO UTC at.
evchk() { node -e 'const [n,kind,url,by]=process.argv.slice(1);const l=require("fs").readFileSync(process.env.AB_EVENTS_FILE,"utf8").split("\n");const e=JSON.parse(l.at(-2));process.exit(l.at(-1)===""&&l.length-1===+n&&JSON.stringify(Object.keys(e))==="[\"at\",\"kind\",\"url\",\"by\"]"&&e.kind===kind&&e.url===url&&e.by===by&&new Date(e.at).toISOString()===e.at?0:1)' "$@"; }
CK0=$(node "$AB" check >/dev/null 2>&1; echo $?)
t 0 "no event log yet"                     test ! -e "$EV"
t 0 "hot marks a waiting PR"               abo hot "$L1"
t 0 "  ...prints section, item with hot_by/hot_at, mark, status changed"  okj 'r.ok&&r.live&&r.status==="changed"&&r.section==="waiting"&&r.item.hot===true&&r.item.hot_by==="cli"&&r.item.hot_at===r.mark.at&&JSON.stringify(Object.keys(r.mark))==="[\"hot\",\"by\",\"at\"]"&&r.mark.hot===true&&r.mark.by==="cli"'
t 0 "  ...hot map entry, by defaults to cli"  test "$(hget '[m.hot,m.by,m.at===b.glance.waiting[0].hot_at]' "$L1")" = '[true,"cli",true]'
t 0 "  ...glance item has hot, hot_by, hot_at"  test "$(gfield '[g.waiting[0].hot,g.waiting[0].hot_by,typeof g.waiting[0].hot_at]')" = '[true,"cli","string"]'
t 0 "  ...event log created with one line {at,kind,url,by}"  evchk 1 hot "$L1" cli
t 0 "  ...event at is the mark's at"       test "$(tail -n 1 "$EV" | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).at))')" = "$(hget 'm.at' "$L1")"
t 0 "hot is logged"                        grep -q '"op":"hot","link":"'"$L1"'"' "$T/app/.ab-log.jsonl"
SUM=$(cksum < "$AB_FILE")
t 0 "hot again"                            abo hot "$L1" --by user
t 0 "  ...status unchanged, the first mark kept"  okj 'r.ok&&r.status==="unchanged"&&r.section==="waiting"&&r.mark.by==="cli"'
t 0 "  ...no new event"                    evchk 1 hot "$L1" cli
t 0 "  ...board.ts not rewritten"          test "$(cksum < "$AB_FILE")" = "$SUM"
t 0 "hot an others PR with --by"           abo hot "$L2" --by assistant_bot-2
t 0 "  ...custom by in mark and item"      okj 'r.status==="changed"&&r.section==="others"&&r.mark.by==="assistant_bot-2"&&r.item.hot_by==="assistant_bot-2"'
t 0 "  ...event with that by"              evchk 2 hot "$L2" assistant_bot-2
t 0 "  ...both hot in the file"            test "$(gfield '[g.waiting[0].hot,g.others[0].hot]')" = '[true,true]'
t 0 "glance refresh without hot keeps both markers"  glance '{"waiting":['"$W1"'],"tickets":[],"others":['"$O1"']}'
t 0 "  ...still hot, hot_by copied from the map"  test "$(gfield '[g.waiting[0].hot,g.others[0].hot,g.waiting[0].hot_by,g.others[0].hot_by]')" = '[true,true,"cli","assistant_bot-2"]'
t 0 "explicit hot sticks across a glance with hot:false"  glance '{"waiting":['"${W1%\}}"',"hot":false}],"tickets":[],"others":['"$O1"']}'
t 0 "  ...waiting still hot"               test "$(gfield '[g.waiting[0].hot,g.others[0].hot]')" = '[true,true]'
t 0 "explicit hot sticks across a glance that leaves the PR out"  glance '{"waiting":[],"tickets":[],"others":['"$O1"']}'
t 0 "  ...and it comes back hot"           glance '{"waiting":['"$W1"'],"tickets":[],"others":['"$O1"']}'
t 0 "  ...hot, with hot_by and hot_at"     test "$(gfield '[g.waiting[0].hot,g.waiting[0].hot_by,g.waiting[0].hot_at]')" = "$(hget '[true,"cli",m.at]' "$L1")"
# A PR with no entry in the hot map keeps the old rules: an explicit hot wins, else carry-over.
t 0 "no-entry PR: explicit hot:true"       glance '{"waiting":['"$W1,${W3%\}}"',"hot":true}],"tickets":[],"others":['"$O1"']}'
t 0 "  ...hot, no hot_by"                  test "$(gfield '[g.waiting[1].hot,"hot_by" in g.waiting[1]]')" = '[true,false]'
t 0 "no-entry PR: carry-over"              glance '{"waiting":['"$W1,$W3"'],"tickets":[],"others":['"$O1"']}'
t 0 "  ...still hot"                       test "$(gfield 'g.waiting[1].hot')" = 'true'
t 0 "no-entry PR: explicit hot:false wins" glance '{"waiting":['"$W1,${W3%\}}"',"hot":false}],"tickets":[],"others":['"$O1"']}'
t 0 "  ...not hot"                         test "$(gfield 'g.waiting[1].hot')" = 'false'
t 0 "unhot an others PR"                   abo unhot "$L2"
t 0 "  ...status changed, hot key gone, hot_by/hot_at set"  okj 'r.status==="changed"&&r.section==="others"&&!("hot" in r.item)&&r.item.hot_by==="cli"&&r.item.hot_at===r.mark.at&&r.mark.hot===false'
t 0 "  ...kept as a hot:false entry (a tombstone)"  test "$(hget '[m.hot,m.by]' "$L2")" = '[false,"cli"]'
t 0 "  ...no hot key in the file"          test "$(gfield '["hot" in g.others[0],g.others[0].hot_by]')" = '[false,"cli"]'
t 0 "  ...unhot event"                     evchk 3 unhot "$L2" cli
t 0 "unhot sticks across a glance that re-hots the PR"  glance '{"waiting":['"$W1"'],"tickets":[],"others":['"${O1%\}}"',"hot":true}]}'
t 0 "  ...not hot"                         test "$(gfield '"hot" in g.others[0]')" = 'false'
t 0 "  ...glance writes no event"          evchk 3 unhot "$L2" cli
t 0 "unhot again"                          abo unhot "$L2"
t 0 "  ...unchanged"                       okj 'r.status==="unchanged"&&r.mark.hot===false'
t 0 "  ...no event"                        evchk 3 unhot "$L2" cli
G0=$(gfield 'g')
t 0 "hot a PR in no glance list (trailing slash)"  abo hot "$L4/"
t 0 "  ...section and item null, mark set" okj 'r.ok&&r.status==="changed"&&r.section===null&&r.item===null&&r.mark.hot===true&&r.mark.by==="cli"'
t 0 "  ...stored under the canonical URL only"  test "$(hget '[m.hot,Object.keys(b.hot).filter((k)=>k.includes("12001"))]' "$L4")" = '[true,["'"$L4"'"]]'
t 0 "  ...glance unchanged"                test "$(gfield 'g')" = "$G0"
t 0 "  ...event has the canonical URL"     evchk 4 hot "$L4" cli
t 0 "unhot with ?query#fragment hits the same entry"  abo unhot "$L4?w=1#top"
t 0 "  ...now hot:false"                   test "$(hget 'm.hot' "$L4")" = 'false'
t 0 "  ...event"                           evchk 5 unhot "$L4" cli
t 0 "glance link with a trailing slash gets the canonical mark"  glance '{"waiting":['"$W1"',{"title":"T4","who":"W","link":"'"$L4"'/"}],"tickets":[],"others":[]}'
t 0 "  ...not hot, hot_by set"             test "$(gfield '["hot" in g.waiting[1],g.waiting[1].hot_by]')" = '[false,"cli"]'
t 0 "hot finds the trailing-slash glance link"  abo hot "$L4" --by abcdefghijabcdefghijabcdefghijab
t 0 "  ...waiting, item hot, 32-char by"   okj 'r.section==="waiting"&&r.item.hot===true&&r.mark.by.length===32&&r.item.hot_by===r.mark.by'
t 0 "glance accepts hot_by and hot_at"     glance '{"waiting":['"$W1"',{"title":"T","who":"W","link":"https://example.com/1","hot":true,"hot_by":"assistant","hot_at":"2026-11-26T10:00:00.000Z"}],"tickets":[],"others":[]}'
t 0 "  ...kept on a PR with no mark"       test "$(gfield '[g.waiting[1].hot_by,g.waiting[1].hot_at]')" = '["assistant","2026-11-26T10:00:00.000Z"]'
t 0 "check exits as before with the hot map"  test "$(node "$AB" check >/dev/null 2>&1; echo $?)" = "$CK0"
t 0 "lint still reads the board"           bash -c "node '$AB' lint | node -e 'if(!Array.isArray(JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")).failing))process.exit(1)'"
t 0 "hot map entries are {hot,by,at}"      test "$(hget 'Object.values(b.hot).every((x)=>JSON.stringify(Object.keys(x))==="[\"hot\",\"by\",\"at\"]")' "")" = 'true'
# The event log comes after board.ts: a failed append warns on stderr, exits 0 and keeps the board write.
t 0 "event log failure still exits 0"      bash -c "AB_EVENTS_FILE='$AB_FILE/no/events.jsonl' node '$AB' hot '$L3' >/dev/null 2>'$T/err'"
t 0 "  ...warns"                           grep -qF 'ab: warning: hot written to board.ts but not to the event log' "$T/err"
t 0 "  ...the mark is on the board"        test "$(hget 'm.hot' "$L3")" = 'true'
t 0 "  ...and nothing reached the log"     test "$(evn)" = 6
SUM=$(cksum < "$AB_FILE"); EVN=$(evn)
t 2 "hot on an invalid owner refused"           node "$AB" hot https://github.com/bad_owner/r/pull/404
t 0 "  ...says why"                        bash -c "node '$AB' hot https://github.com/bad_owner/r/pull/404 2>&1 | grep -qF 'ab: hot: url must be a GitHub PR URL of the form https://github.com/<owner>/<repo>/pull/<number>, got https://github.com/bad_owner/r/pull/404 (the owner is missing or invalid)'"
t 2 "unhot on an invalid owner refused"         node "$AB" unhot https://github.com/bad_owner/r/pull/404
t 2 "hot on a PR sub-page refused"         node "$AB" hot "$L1/files"
t 2 "hot on an issue URL refused"          node "$AB" hot https://github.com/acme/example-api/issues/5
t 2 "hot over http refused"                node "$AB" hot http://github.com/acme/example-api/pull/11764
t 2 "hot on another host refused"          node "$AB" hot https://example.com/acme/example-api/pull/11764
t 2 "hot without a url refused"            node "$AB" hot
t 0 "  ...usage"                           bash -c "node '$AB' hot 2>&1 | grep -qF 'ab: usage: ab hot <pr-url> [--by name]'"
t 2 "hot with a non-url refused"           node "$AB" hot pull/11764
t 2 "hot with two urls refused"            node "$AB" hot "$L1" "$L2"
t 2 "--by with a space refused"            node "$AB" hot "$L1" --by "assistant bot"
t 2 "--by with a dot refused"              node "$AB" unhot "$L1" --by assistant.bot
t 2 "--by over 32 chars refused"           node "$AB" unhot "$L1" --by abcdefghijabcdefghijabcdefghijabc
t 2 "--by empty refused"                   node "$AB" unhot "$L1" --by ""
t 2 "--by without a value refused"         node "$AB" unhot "$L1" --by
t 0 "  ...says why"                        bash -c "node '$AB' unhot '$L1' --by 'a b' 2>&1 | grep -qF 'ab: unhot: --by must be 1 to 32 letters, digits, _ or -'"
t 2 "glance blank hot_by refused"          glance '{"waiting":[{"title":"T","who":"W","link":"https://example.com/1","hot_by":" "}],"tickets":[]}'
t 2 "glance non-string hot_at refused"     glance '{"waiting":[],"tickets":[],"others":[{"title":"T","author":"A","who":"W","link":"https://example.com/1","hot_at":5}]}'
t 0 "  ...says why"                        bash -c "echo '{\"waiting\":[],\"tickets\":[],\"others\":[{\"title\":\"T\",\"author\":\"A\",\"who\":\"W\",\"link\":\"https://example.com/1\",\"hot_at\":5}]}' | node '$AB' glance 2>&1 | grep -qF 'ab: glance.others[0].hot_at must be a non-blank string'"
t 0 "hot refusals log no event"            test "$(evn)" = "$EVN"
t 2 "glance blank base refused"            glance '{"waiting":[{"title":"T","who":"W","link":"https://example.com/1","base":" "}],"tickets":[]}'
t 0 "  ...says why"                        bash -c "echo '{\"waiting\":[{\"title\":\"T\",\"who\":\"W\",\"base\":\"\"}],\"tickets\":[]}' | node '$AB' glance 2>&1 | grep -qF 'ab: glance.waiting[0].base must be a non-blank string (a branch name)'"
t 2 "glance non-string head refused"       glance '{"waiting":[],"tickets":[],"others":[{"title":"T","author":"A","who":"W","link":"https://example.com/1","head":3}]}'
t 2 "glance non-boolean hot refused"       glance '{"waiting":[],"tickets":[],"others":[{"title":"T","author":"A","who":"W","link":"https://example.com/1","hot":"yes"}]}'
t 0 "  ...says why"                        bash -c "echo '{\"waiting\":[],\"tickets\":[],\"others\":[{\"title\":\"T\",\"author\":\"A\",\"who\":\"W\",\"link\":\"https://example.com/1\",\"hot\":1}]}' | node '$AB' glance 2>&1 | grep -qF 'ab: glance.others[0].hot must be true or false'"
t 0 "hot and glance refusals leave board.ts unchanged"  test "$(cksum < "$AB_FILE")" = "$SUM"
# To-do list: todo-* on a temp todos.ts (AB_TODOS_FILE), never the real one.
cp "$(dirname "$0")/../app/src/data/todos.ts" "$T/app/src/data/todos.ts"
export AB_TODOS_FILE="$T/app/src/data/todos.ts"
node -e 'const fs=require("fs"),f=process.env.AB_TODOS_FILE,s=fs.readFileSync(f,"utf8"),A="/* TODOS-JSON-START */",i=s.indexOf(A)+A.length,j=s.indexOf("/* TODOS-JSON-END */");fs.writeFileSync(f,s.slice(0,i)+"\n"+JSON.stringify({updated_at:"2026-11-26T15:00:00.000Z",items:[]},null,2)+"\n"+s.slice(j))'
cp "$AB_TODOS_FILE" "$T/todos.empty"
dget() { node -e 'const s=require("fs").readFileSync(process.env.AB_TODOS_FILE,"utf8");const A="/* TODOS-JSON-START */";const t=JSON.parse(s.slice(s.indexOf(A)+A.length,s.indexOf("/* TODOS-JSON-END */")));const by=(id)=>t.items.find(x=>x.id===id);console.log(JSON.stringify(eval(process.argv[1])))' "$1"; }
td() { local c=$1; shift; node "$AB" "$c" "$@"; }
derr() { local c=$1 j=$2 want=$3; node "$AB" "$c" "$j" 2>&1 | grep -qF "$want"; }
TODAY=$(node -e 'const p=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()).map(x=>[x.type,x.value]));console.log(p.year+"-"+p.month+"-"+p.day)')
t 0 "todo-add quick keeps date words"      td todo-add '{"id":"call-vendor","quick":"call the vendor Friday 3pm p1"}'
t 0 "  ...stored without due"              test "$(dget '[by("call-vendor").name,by("call-vendor").priority,"due" in by("call-vendor")]')" = '["call the vendor Friday 3pm","urgent",false]'
t 0 "todo-add without a date from stdin"   bash -c "echo '{\"id\":\"pay-rent\",\"name\":\"Pay rent\",\"priority\":\"low\"}' | node '$AB' todo-add"
t 0 "  ...stores the named task without due" test "$(dget '[by("pay-rent").name,"due" in by("pay-rent")]')" = '["Pay rent",false]'
t 0 "todo-update accepts a legacy due date" td todo-update '{"id":"pay-rent","due":{"date":"'"$TODAY"'"}}'
t 0 "todo-add generates an id"             bash -c "node '$AB' todo-add '{\"name\":\"Find the lease PDF\",\"parent_id\":\"call-vendor\"}' | grep -q '\"id\":\"find-the-lease-pdf-[0-9a-f]\{6\}\"'"
SUB=$(dget 't.items[2].id' | tr -d '"')
t 0 "  ...stored as a subtask, default medium"  test "$(dget '[t.items[2].parent_id,t.items[2].priority,t.items.length]')" = '["call-vendor","medium",3]'
t 0 "todo-update fields"                   td todo-update '{"id":"call-vendor","description":"Ask about the lease","priority":"high","due":{"date":"2026-12-01","time":"09:30"}}'
t 0 "  ...stored, created_at kept"         test "$(dget '[by("call-vendor").description,by("call-vendor").priority,by("call-vendor").due.time,by("call-vendor").updated_at>=by("call-vendor").created_at]')" = '["Ask about the lease","high","09:30",true]'
t 0 "todo-update null clears due and description"  td todo-update '{"id":"call-vendor","due":null,"description":null}'
t 0 "  ...cleared"                         test "$(dget '["due" in by("call-vendor"),"description" in by("call-vendor")]')" = '[false,false]'
t 0 "todo-comment with --author"           bash -c "node '$AB' todo-comment '{\"id\":\"call-vendor\",\"text\":\" Left a voicemail \"}' --author Assistant | grep -q '\"text\":\"Left a voicemail\",\"author\":\"Assistant\"'"
t 0 "todo-comment defaults to bot"         bash -c "node '$AB' todo-comment '{\"id\":\"call-vendor\",\"text\":\"Second\"}' | grep -q '\"author\":\"bot\"'"
t 0 "  ...two comments in order"           test "$(dget 'by("call-vendor").comments.map(c=>c.author)')" = '["Assistant","bot"]'
t 0 "todo-list --view today has the to-do due today"  bash -c "node '$AB' todo-list --view today | grep -q '\"id\":\"pay-rent\"'"
t 0 "todo-list --view upcoming lists the undated one"  bash -c "node '$AB' todo-list --view upcoming | grep -q '\"id\":\"call-vendor\"'"
t 0 "todo-list (all) lists every item"     test "$(node "$AB" todo-list | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).length)')" = 3
t 0 "todo-done"                            bash -c "node '$AB' todo-done '{\"id\":\"call-vendor\"}' | grep -q '\"status\":\"done\"'"
t 0 "  ...subtask left open"               test "$(dget '["done_at" in by("call-vendor"),"done_at" in t.items[2]]')" = '[true,false]'
t 0 "todo-done again is a no-op"           bash -c "node '$AB' todo-done '{\"id\":\"call-vendor\"}' | grep -q '\"status\":\"already-done\"'"
t 0 "todo-list --view done has it"         bash -c "node '$AB' todo-list --view done | grep -q '\"id\":\"call-vendor\"'"
t 0 "todo-reopen"                          bash -c "node '$AB' todo-reopen '{\"id\":\"call-vendor\"}' | grep -q '\"status\":\"reopened\"'"
t 0 "  ...done_at gone"                    test "$(dget '"done_at" in by("call-vendor")')" = false
t 0 "todo-reopen again is a no-op"         bash -c "node '$AB' todo-reopen '{\"id\":\"call-vendor\"}' | grep -q '\"status\":\"already-open\"'"
t 0 "todo commands are logged"             bash -c "for op in todo-add todo-update todo-comment todo-done todo-reopen; do grep -q '\"op\":\"'\$op'\"' '$T/app/.ab-log.jsonl' || exit 1; done"
DSUM=$(cksum < "$AB_TODOS_FILE")
t 2 "todo-add quick with no name refused"  td todo-add '{"quick":"p1"}'
t 0 "  ...says why"                        derr todo-add '{"quick":"p1"}' 'ab: todo-add: quick add needs a name besides the priority'
t 2 "todo-add without name or quick refused"  td todo-add '{"priority":"high"}'
t 2 "todo-add blank name refused"          td todo-add '{"name":"  "}'
t 2 "todo-add 201-char name refused"       td todo-add '{"name":"'"$(printf 'a%.0s' $(seq 201))"'"}'
t 2 "todo-add bad priority refused"        td todo-add '{"name":"x","priority":"p1"}'
t 0 "  ...says why"                        derr todo-add '{"name":"x","priority":"top"}' 'ab: todo-add: priority must be urgent, high, medium or low'
t 2 "todo-add impossible date refused"     td todo-add '{"name":"x","due":{"date":"2026-02-30"}}'
t 0 "  ...says why"                        derr todo-add '{"name":"x","due":{"date":"2026-13-01"}}' 'ab: todo-add: due.date must be a real calendar date written YYYY-MM-DD'
t 2 "todo-add bad time refused"            td todo-add '{"name":"x","due":{"date":"2026-12-01","time":"3pm"}}'
t 2 "todo-add unknown key refused"         td todo-add '{"name":"x","labels":["home"]}'
t 0 "  ...says why"                        derr todo-add '{"name":"x","labels":["home"]}' 'ab: todo-add: unknown key labels'
t 2 "todo-add unknown parent refused"      td todo-add '{"name":"x","parent_id":"nope"}'
t 2 "todo-add subtask of a subtask refused"  td todo-add '{"name":"x","parent_id":"'"$SUB"'"}'
t 0 "  ...says why"                        derr todo-add '{"name":"x","parent_id":"'"$SUB"'"}' 'is a subtask itself; subtasks go one level deep'
t 2 "todo-add duplicate id refused"        td todo-add '{"id":"call-vendor","name":"x"}'
t 2 "todo-add bad JSON refused"            td todo-add '{"name":}'
t 2 "todo-update nothing to change refused"  td todo-update '{"id":"call-vendor"}'
t 2 "todo-update own parent refused"       td todo-update '{"id":"call-vendor","parent_id":"call-vendor"}'
t 2 "todo-update parent with subtasks cannot become a subtask"  td todo-update '{"id":"call-vendor","parent_id":"pay-rent"}'
t 5 "todo-update unknown id"               td todo-update '{"id":"nope","name":"x"}'
t 0 "  ...says why"                        bash -c "node '$AB' todo-update '{\"id\":\"nope\",\"name\":\"x\"}' 2>&1 | grep -qF 'ab: todo-update: no to-do nope'"
t 2 "todo-comment blank text refused"      td todo-comment '{"id":"call-vendor","text":" "}'
t 2 "todo-comment 4001-char text refused"  td todo-comment '{"id":"call-vendor","text":"'"$(printf 'a%.0s' $(seq 4001))"'"}'
t 2 "todo-comment author twice refused"    td todo-comment '{"id":"call-vendor","text":"x","author":"Assistant"}' --author Assistant
t 5 "todo-comment unknown id"              td todo-comment '{"id":"nope","text":"x"}'
t 5 "todo-done unknown id"                 td todo-done '{"id":"nope"}'
t 2 "todo-done without id refused"         td todo-done '{}'
t 2 "todo-done bare id refused"            td todo-done call-vendor
t 5 "todo-reopen unknown id"               td todo-reopen '{"id":"nope"}'
t 2 "todo-list bad view refused"           td todo-list --view week
t 0 "todo refusals leave todos.ts unchanged"  test "$(cksum < "$AB_TODOS_FILE")" = "$DSUM"
t 0 "  ...and leave no temp or lock files"  test -z "$(ls "$T/app/src/data" | grep -v '\.ts$')"
t 0 "check passes with a good todos.ts"    node "$AB" check
cp "$AB_TODOS_FILE" "$T/todos.good"
echo 'export const todos = {};' > "$AB_TODOS_FILE"
t 2 "todo-add on todos.ts without markers refused"  td todo-add '{"name":"x"}'
t 0 "  ...says why"                        derr todo-add '{"name":"x"}' 'ab: todos file needs exactly one TODOS-JSON-START and one TODOS-JSON-END marker'
t 2 "todo-list on todos.ts without markers refused"  td todo-list
t 1 "check flags todos.ts without markers" node "$AB" check
t 0 "  ...names it"                        bash -c "node '$AB' check | grep -qF 'todos file needs exactly one TODOS-JSON-START'"
rm "$AB_TODOS_FILE"
t 2 "todo-done with no todos.ts refused"   td todo-done '{"id":"call-vendor"}'
t 0 "check does not need a todos.ts"       node "$AB" check
cp "$T/todos.good" "$AB_TODOS_FILE"
# Link guard on raise: github.com / linear.app links must be the exact PR / issue URL, and match a bare card_ref.
# Each refusal exits 2 with "ab: raise: <message>" and leaves board.ts byte-identical.
lg() { local id=$1 ref=$2 link=$3; echo '{"id":"'"$id"'","title":"Link guard card",'"$CTX"',"card_ref":'"$ref"',"question":"Ship the link guard test card?","what_happens_after":"A.","options":[{"id":"a","label":"A"}]'"${link:+,\"link\":$link}"'}'; }
lgbad() { # name card_ref link expected-message
  local s=$(cksum < "$AB_FILE"); out=$(node "$AB" raise "$(lg t-lg-bad "$2" "$3")" 2>&1); got=$?
  if [ $got = 2 ] && [ "$out" = "ab: raise: $4" ] && [ "$(cksum < "$AB_FILE")" = "$s" ]; then pass=$((pass+1)); echo "PASS link guard refuses: $1"
  else fail=$((fail+1)); echo "FAIL link guard refuses: $1 (exit $got, board $([ "$(cksum < "$AB_FILE")" = "$s" ] && echo same || echo CHANGED)): $out"; fi; }
GHW='link must be a GitHub PR URL of the form https://github.com/<owner>/<repo>/pull/<number>, got'
LNW='link must be a Linear issue URL of the form https://linear.app/<workspace>/issue/<KEY-N>, got'
lgbad "http:// GitHub link"        null '"http://github.com/acme/example-web/pull/11550"' "$GHW http://github.com/acme/example-web/pull/11550 (it must use https://)"
lgbad "GitHub link, invalid owner"     null '"https://github.com/bad_owner/example-web/pull/11550"' "$GHW https://github.com/bad_owner/example-web/pull/11550 (the owner is missing or invalid)"
lgbad "GitHub issues/ path"        null '"https://github.com/acme/example-web/issues/11550"' "$GHW https://github.com/acme/example-web/issues/11550 (it must be a /pull/ URL, not /issues/)"
lgbad "GitHub tree/ path"          null '"https://github.com/acme/example-web/tree/main"' "$GHW https://github.com/acme/example-web/tree/main (it must be a /pull/ URL, not /tree/)"
lgbad "GitHub link, no PR number"  null '"https://github.com/acme/example-web/pull/"' "$GHW https://github.com/acme/example-web/pull/ (the PR number is missing)"
lgbad "Linear invalid workspace"     null '"https://linear.app/bad_workspace/issue/PROJ-15054"' "$LNW https://linear.app/bad_workspace/issue/PROJ-15054 (the workspace is missing or invalid)"
lgbad "look-alike github.com.example.com"  null '"https://github.com.example.com/acme/example-web/pull/11550"' "$GHW https://github.com.example.com/acme/example-web/pull/11550 (the host must be exactly github.com)"
lgbad "look-alike linear.app@x"    null '"https://linear.app@example.com/acme/issue/PROJ-15054"' "$LNW a URL with user:password@ (it has credentials before the host)"
lgbad "bad card_ref URL, no link"  '"https://github.com/acme/example-web/issues/11550"' "" "card_ref must be a GitHub PR URL of the form https://github.com/<owner>/<repo>/pull/<number>, got https://github.com/acme/example-web/issues/11550 (it must be a /pull/ URL, not /issues/)"
lgbad "PR number mismatch"         '"#11550"' '"https://github.com/acme/example-web/pull/731"' "link PR number 731 does not match card_ref #11550"
lgbad "repo mismatch"              '"example-api#11550"' '"https://github.com/acme/example-web/pull/11550"' "link repo example-web does not match card_ref example-api#11550"
lgbad "kind mismatch (PR ref, Linear link)"  '"#11550"' '"https://linear.app/example-team/issue/PROJ-11550"' "link is a Linear issue URL but card_ref #11550 is a PR; use https://github.com/<owner>/<repo>/pull/11550"
lgbad "ticket key mismatch"        '"PROJ-15054"' '"https://linear.app/example-team/issue/PROJ-15055"' "link ticket PROJ-15055 does not match card_ref PROJ-15054"
lgbad "bare ref, non-PR link"      '"#11550"' '"https://example.com/pr/11550"' "link must be a GitHub PR URL for card_ref #11550 (https://github.com/<owner>/<repo>/pull/11550), got https://example.com/pr/11550"
lgok() { t 0 "link guard allows: $1" node "$AB" raise "$(lg "$2" "$3" "$4")"; }
lgok "good PR URL"                 t-lg-pr '"example-web#11550"' '"https://github.com/acme/example-web/pull/11550"'
lgok "good PR URL with /files?x#y" t-lg-pr2 '"#11550"' '"https://github.com/acme/example-web/pull/11550/files?w=1#top"'
lgok "good Linear URL (example-team)"   t-lg-lin1 '"PROJ-15054"' '"https://linear.app/example-team/issue/PROJ-15054/emergency-contact"'
lgok "good Linear URL (alternate workspace)"      t-lg-lin2 '"PROJ-15054"' '"https://linear.app/acme/issue/PROJ-15054"'
lgok "bare PR ref, no link"        t-lg-bare '"example-web#11550"' ''
lgok "ticket key, no link"         t-lg-key '"PROJ-14382"' ''
lgok "null card_ref, no link"      t-lg-null null ''
lgok "plain-words card_ref"        t-lg-words '"Coolify preview"' ''
lgok "URL on another host"         t-lg-other '"https://example.com/messages/1"' ''
lgok "link only (fills card_ref)"  t-lg-only null '"https://github.com/acme/example-api/pull/11764"'
t 0 "  ...link stored, card_ref filled, printed card links it"  bash -c "node -e 'const d=JSON.parse(process.argv[1]).d;if(d.link!==\"https://github.com/acme/example-api/pull/11764\"||d.card_ref!==d.link)process.exit(1)' '$(dx t-lg-only)' && node '$AB' raise '$(lg t-lg-only null '"https://github.com/acme/example-api/pull/11764"')' | grep -qF '\"link\": \"https://github.com/acme/example-api/pull/11764\"'"
t 0 "  ...link and bare card_ref both stored"  node -e 'const d=JSON.parse(process.argv[1]).d;if(d.card_ref!=="example-web#11550"||d.link!=="https://github.com/acme/example-web/pull/11550")process.exit(1)' "$(dx t-lg-pr)"
lgre() { local s=$(cksum < "$AB_FILE"); out=$(node "$AB" raise "$(lg t-lg-pr '"example-web#11550"' '"https://github.com/acme/example-web/pull/731"')" 2>&1); got=$?
  [ $got = 2 ] && [ "$out" = "ab: raise: link PR number 731 does not match card_ref example-web#11550" ] && [ "$(cksum < "$AB_FILE")" = "$s" ]; }
t 0 "re-raise of an existing card is validated too (exit 2, board.ts unchanged)"  lgre
t 2 "link that is not a string refused"  node "$AB" raise "$(lg t-lg-num null 11550)"
t 0 "lint and check flag none of the cards with a link"  bash -c "{ node '$AB' lint; echo; node '$AB' check; } | node -e 'const [l,c]=require(\"fs\").readFileSync(0,\"utf8\").split(/\n(?=\{)/).map(JSON.parse);if(JSON.stringify([l.failing,c.problems]).includes(\"t-lg-\"))process.exit(1)'"
t 0 "  ...check still parses the board with link stored"  bash -c "node '$AB' check | grep -q t-lg-pr"
# Replay the real Nov 10 miss: board as it was at 12:44 PM ET, before the Sentry card reached it.
PAST="${PAST:-$HOME/action-board/backups/board.ts.20261110-124417.bak}"
if [ -f "$PAST" ]; then cp "$PAST" "$AB_FILE"
  t 1 "replay: Sentry chat card missing from board is caught" node "$AB" check --chat sentry-empty-wrapup-1770
  bash -c "node '$AB' check --chat sentry-empty-wrapup-1770 | grep -q 'sentry-empty-wrapup-1770 is NOT on the board'" && { pass=$((pass+1)); echo "PASS replay names the fix"; } || { fail=$((fail+1)); echo "FAIL replay message"; }
fi
echo "passed $pass failed $fail"; rm -rf "$T"; [ $fail = 0 ]
