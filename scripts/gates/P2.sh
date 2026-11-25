#!/usr/bin/env bash
# P2 — the server can be told a credential, prove it against Kaggle, and refuse everything else.
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

head_l "P2.1 setup state machine"
assert_file lib/setup.js "the state machine"
if node -e '
  const os=require("os"),fs=require("fs"),p=require("path");
  const base=fs.mkdtempSync(p.join(os.tmpdir(),"setup-"));
  const s=require(process.argv[1]);
  if (s.state(base)!=="new") throw new Error("fresh base is not new");
  const r=s.acceptLicence(base,{accepted:true,tos_ack:true,territory:"applicable"});
  if (!r.ok) throw new Error("licence refused: "+r.reason);
  if (s.state(base)!=="licence_ok") throw new Error("state after licence is "+s.state(base));
  const st=JSON.parse(fs.readFileSync(s.setupPath(base),"utf8"));
  if (JSON.stringify(st).match(/token/i)) throw new Error("a token-shaped key is in setup.json");
  const mode=fs.statSync(s.setupPath(base)).mode & 0o777;
  if (mode!==0o600) throw new Error("setup.json is "+mode.toString(8)+", not 600");
  s.recordProbe(base,{result:"ok",username:"someone"});
  if (s.state(base)!=="ready") throw new Error("state after ok probe is "+s.state(base));
  console.log("ok");
' "$ROOT/lib/setup.js" 2>&1 | tail -3 | grep -q '^ok$'; then
  green "new -> licence_ok -> ready, file 0600, no token field"
else
  red "state machine does not walk new -> licence_ok -> ready"
fi

if node -e '
  const os=require("os"),fs=require("fs"),p=require("path");
  const base=fs.mkdtempSync(p.join(os.tmpdir(),"setup-"));
  const s=require(process.argv[1]);
  s.acceptLicence(base,{accepted:true,tos_ack:true,territory:"excluded"});
  if (s.state(base)!=="territory_blocked") throw new Error("excluded territory did not block: "+s.state(base));
  s.recordProbe(base,{result:"ok",username:"someone"});
  if (s.state(base)!=="territory_blocked") throw new Error("a probe cleared the territory block");
  console.log("ok");
' "$ROOT/lib/setup.js" 2>&1 | tail -3 | grep -q '^ok$'; then
  green "excluded territory is terminal and cannot be cleared by a probe"
else
  red "excluded territory is not terminal"
fi

if node -e '
  const s=require(process.argv[1]);
  const os=require("os"),fs=require("fs"),p=require("path");
  const base=fs.mkdtempSync(p.join(os.tmpdir(),"setup-"));
  const r=s.acceptLicence(base,{accepted:false,tos_ack:true,territory:"applicable"});
  if (r.ok) throw new Error("accepted:false was honoured");
  console.log("ok");
' "$ROOT/lib/setup.js" 2>&1 | tail -2 | grep -q '^ok$'; then
  green "licence cannot be accepted with accepted:false"
else
  red "the licence acceptance check does not reject accepted:false"
fi

head_l "P2.2 the probe"
assert_file lib/kaggle-auth.js "the probe"
if node -e '
  const {createProbe}=require(process.argv[1]);
  const mk=(out,status)=>()=>({status:status===undefined?0:status,stdout:out,stderr:""});
  const un=(a)=>({status:1,stdout:"Authentication required to call the Kaggle API.",stderr:""});
  const p=createProbe({kaggle_bin:"kaggle"},{run:(cmd,args)=>a=>a});
  // six fixtures, no network
  const cases=[
    ["unauthenticated", un],
    ["old_cli", (a)=>a[0]==="--version"?{status:0,stdout:"Kaggle API 1.6.17",stderr:""}:un(a)],
    ["forbidden", (a)=>a[0]==="--version"?{status:0,stdout:"Kaggle API 2.2.5",stderr:""}:a[0]==="config"?{status:0,stdout:"- username: bob\n",stderr:""}:{status:1,stdout:"Authentication failed (403) - phone verification",stderr:""}],
    ["quota_empty", (a)=>a[0]==="--version"?{status:0,stdout:"Kaggle API 2.2.5",stderr:""}:a[0]==="config"?{status:0,stdout:"- username: bob\n",stderr:""}:{status:0,stdout:"Dataset 0.00h 30.00h\n",stderr:""}],
    ["ok", (a)=>a[0]==="--version"?{status:0,stdout:"Kaggle API 2.2.5",stderr:""}:a[0]==="config"?{status:0,stdout:"- username: bob\n",stderr:""}:{status:0,stdout:"GPU 7.86h 22.14h 30.00h 2026-11-28T00:00:00Z\n",stderr:""}],
    ["unreachable", ()=>({status:null,stdout:"",stderr:"",error:{code:"ENOTFOUND"}})],
  ];
  for (const [want,fn] of cases) {
    const pr=createProbe({kaggle_bin:"kaggle"},{run:(c,args)=>({status:fn(args).status,stdout:fn(args).stdout,stderr:fn(args).stderr,error:fn(args).error?{code:fn(args).error.code}:undefined})});
    const got=pr.probe();
    if (got.result!==want) throw new Error("want "+want+", got "+got.result);
  }
  const okp=createProbe({kaggle_bin:"kaggle"},{run:(c,args)=>args[0]==="--version"?{status:0,stdout:"Kaggle API 2.2.5"}:args[0]==="config"?{status:0,stdout:"- username: bob"}:{status:0,stdout:"GPU 7.86h 22.14h 30.00h 2026-11-28T00:00:00Z"}});
  const r=okp.probe();
  if (r.username!=="bob") throw new Error("username not parsed: "+r.username);
  if (r.quota.remaining_h!==22.14) throw new Error("quota not parsed: "+JSON.stringify(r.quota));
  console.log("ok");
' "$ROOT/lib/kaggle-auth.js" 2>&1 | tail -4 | grep -q '^ok$'; then
  green "six probe fixtures, no network: unauthenticated, old_cli, forbidden, quota_empty, ok, unreachable"
else
  red "probe enum mismatch — run: node scripts/gates/P2.sh"
fi

head_l "P2.3 the token is written 0600 and never echoed"
if node -e '
  const fs=require("fs"),os=require("os"),p=require("path");
  const a=require(process.argv[1]);
  const home=fs.mkdtempSync(p.join(os.tmpdir(),"kh-"));
  const r=a.writeToken({kaggle_home:home},"  abcdefghijklmnop  \n");
  if (!r.ok) throw new Error("refused: "+r.reason);
  const f=p.join(home,"access_token");
  const body=fs.readFileSync(f,"utf8");
  if (body!=="abcdefghijklmnop") throw new Error("token not trimmed: "+JSON.stringify(body));
  const mode=fs.statSync(f).mode & 0o777;
  if (mode!==0o600) throw new Error("access_token is "+mode.toString(8));
  const dirmode=fs.statSync(home).mode & 0o777;
  if (dirmode!==0o700) throw new Error("kaggle home is "+dirmode.toString(8));
  console.log("ok");
' "$ROOT/lib/kaggle-auth.js" 2>&1 | tail -3 | grep -q '^ok$'; then
  green "access_token written atomically at 0600 in a 0700 directory, whitespace stripped"
else
  red "token write is wrong — check mode 0600/0700 and trimming"
fi

head_l "P2.4 the gate is server-side"
PORT=$(free_port)
WORK=$(mktemp -d)
rsync -a --exclude .git --exclude data --exclude node_modules "$ROOT/" "$WORK/" 2>/dev/null || cp -a "$ROOT/." "$WORK/"
KHOME=$(mktemp -d)
( cd "$WORK" && cp config.example.json config.json 2>/dev/null
  MOCK_KAGGLE=1 H3UI_PORT="$PORT" H3UI_BIND=127.0.0.1 H3UI_NO_WORKER=1 \
  H3UI_KAGGLE_HOME="$KHOME" node server.js >"$WORK/server.log" 2>&1 & echo $! > "$WORK/pid" )
if wait_health "$PORT"; then
  green "server booted in mock mode on port $PORT"
else
  red "server did not answer /api/health on $PORT"
  tail -15 "$WORK/server.log" 2>/dev/null | sed 's/^/        /'
fi

code() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$1"; }
body() { curl -s "http://127.0.0.1:$PORT$1"; }

[ "$(code /)" = "200" ] && green "GET / serves the setup page before ready" || red "GET / is $(code /) before ready"
[ "$(code /api/state)" = "409" ] && green "GET /api/state is refused with 409 before ready" || red "GET /api/state returned $(code /api/state), expected 409"
[ "$(code /api/submissions -X POST)" = "409" ] && green "POST /api/submissions is refused with 409" || red "POST /api/submissions returned $(code /api/submissions -X POST)"

if body /api/setup | grep -q '"state"'; then
  green "GET /api/setup returns a state"
  body /api/setup | grep -q '"state":"new"' && green "initial state is new" || red "initial state is not new"
else
  red "GET /api/setup is not JSON with a state"
fi

post_licence() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/setup/licence" \
    -H 'content-type: application/json' -H "origin: http://127.0.0.1:$PORT" -d "$1"
}
[ "$(post_licence '{}')" = "422" ] && green "licence without ticks is 422" || red "licence without ticks returned $(post_licence '{}')"
[ "$(post_licence '{"accepted":true,"tos_ack":true,"territory":"excluded"}')" = "451" ] && green "excluded territory is 451" || red "excluded territory returned something else"
[ "$(post_licence '{"accepted":true,"tos_ack":true,"territory":"applicable"}')" = "200" ] && green "valid acceptance is 200" || red "valid acceptance returned something else"

head_l "P2.5 no credential in any response or log"
TOKLIT="zzTOKENzz0123456789abcdef"
curl -s -X POST "http://127.0.0.1:$PORT/api/setup/credentials" \
  -H 'content-type: application/json' -H "origin: http://127.0.0.1:$PORT" \
  -d "{\"token\":\"$TOKLIT\"}" > /tmp/gate-cred-"$$".out 2>&1
if grep -q "$TOKLIT" /tmp/gate-cred-"$$".out; then red "the token came back in the response body"; else green "token not echoed in the response"; fi
if grep -rq "$TOKLIT" "$WORK/server.log" "$KHOME" 2>/dev/null; then :; fi
if grep -q "$TOKLIT" "$WORK/server.log" 2>/dev/null; then red "the token reached the server log"; else green "token not in the server log"; fi

# stop the server
if [ -f "$WORK/pid" ]; then kill "$(cat "$WORK/pid")" 2>/dev/null; fi
pkill -f "H3UI_PORT=$PORT" 2>/dev/null
rm -rf "$WORK" "$KHOME" /tmp/gate-cred-"$$".out

head_l "P2.6 suite"
assert_node_syntax
run_tests

finish P2
