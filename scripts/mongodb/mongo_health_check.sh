#!/usr/bin/env bash
#
# mongo_health_check.sh - check that a MongoDB server is up, find out whether it
# is a standalone server, a replica set or a sharded cluster, and log the status
# of every node to a timestamped log file.
#
# Usage:
#   ./mongo_health_check.sh                 # asks for the server IP
#   ./mongo_health_check.sh 192.168.1.50    # IP given up front (for cron)
#   ./mongo_health_check.sh 192.168.1.50:27018
#
# Works offline. Needs bash, coreutils and a MongoDB shell (mongosh, or the
# legacy "mongo" shell) on the machine that runs it. Port, credentials and TLS
# are optional settings in mongo_health_check.conf next to this script.
#
# Exit codes: 0 OK, 1 WARNING, 2 CRITICAL, 3 UNKNOWN (no shell / bad input)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- settings (defaults; override in the config file) ---------------------
MONGO_PORT=27017
MONGO_USER=""                 # leave empty when auth is disabled
MONGO_PASS=""
MONGO_AUTH_DB="admin"
SHARD_USER=""                 # shard-local user for sharded clusters (optional)
SHARD_PASS=""
MONGO_TLS=0                   # 1 = connect with TLS
MONGO_TLS_CA=""               # CA file for TLS
MONGO_TLS_INSECURE=0          # 1 = accept self-signed / mismatched certificates
MONGO_SHELL=""                # empty = use mongosh, else mongo
TIMEOUT_SECS=10               # per connection attempt
LAG_WARN_SECS=30              # replication lag thresholds
LAG_CRIT_SECS=300
DIRECT_PROBE=1                # 1 = also connect to every node from this machine
LOG_DIR="$SCRIPT_DIR/logs"
LOG_RETENTION_DAYS=30

CONFIG_FILE="${MONGO_HEALTH_CONF:-$SCRIPT_DIR/mongo_health_check.conf}"
# shellcheck source=/dev/null
[[ -f $CONFIG_FILE ]] && source "$CONFIG_FILE"

usage() { sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; }

# ---- input: the server IP -------------------------------------------------
TARGET="${1:-}"
case "$TARGET" in
  -h|--help) usage; exit 0 ;;
esac
if [[ -z $TARGET ]]; then
  if [[ -t 0 ]]; then
    read -rp "Enter MongoDB server IP: " TARGET
  else
    echo "No IP given. Usage: $0 <ip>[:port]" >&2; exit 3
  fi
fi
TARGET="${TARGET//[[:space:]]/}"
SEED_IP="${TARGET%%:*}"
SEED_PORT="$MONGO_PORT"
[[ $TARGET == *:* ]] && SEED_PORT="${TARGET##*:}"

valid_ip() {
  local ip=$1 o
  [[ $ip =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for o in "${BASH_REMATCH[@]:1}"; do (( 10#$o <= 255 )) || return 1; done
}
if ! valid_ip "$SEED_IP"; then echo "Invalid IP address: '$SEED_IP'" >&2; exit 3; fi
if ! [[ $SEED_PORT =~ ^[0-9]+$ ]] || (( SEED_PORT < 1 || SEED_PORT > 65535 )); then
  echo "Invalid port: '$SEED_PORT'" >&2; exit 3
fi

# ---- logging ---------------------------------------------------------------
mkdir -p "$LOG_DIR" || { echo "Cannot create log directory $LOG_DIR" >&2; exit 3; }
RUN_TS="$(date '+%Y%m%d_%H%M%S')"
LOG_FILE="$LOG_DIR/mongo_health_${SEED_IP}_${RUN_TS}.log"
HISTORY_FILE="$LOG_DIR/mongo_health_history.log"
: >"$LOG_FILE"

log() { local l; l="$(date '+%Y-%m-%d %H:%M:%S') $*"; echo "$l" >>"$LOG_FILE"; echo "$l"; }
section() { log ""; log "==== $* ===="; }

OVERALL=0
ISSUES=()
sev_name() { case $1 in 0) echo OK ;; 1) echo WARNING ;; 2) echo CRITICAL ;; *) echo UNKNOWN ;; esac; }
raise() { local lvl=$1; shift; (( lvl > OVERALL )) && OVERALL=$lvl; ISSUES+=("$(sev_name "$lvl"): $*"); }

ERR_TMP="$(mktemp)"
trap 'rm -f "$ERR_TMP"' EXIT

# Stop two runs (e.g. overlapping cron jobs) for the same IP from interleaving.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOG_DIR/.lock_${SEED_IP}"
  flock -n 9 || { log "Another check for $SEED_IP is still running; exiting."; exit 3; }
fi

find "$LOG_DIR" -maxdepth 1 -name 'mongo_health_*_[0-9]*.log' -mtime +"$LOG_RETENTION_DAYS" -delete 2>/dev/null

# ---- helpers ---------------------------------------------------------------
fmt_uptime() {
  local s=${1%%.*}
  [[ $s =~ ^[0-9]+$ ]] || { echo "-"; return; }
  printf '%dd %02dh %02dm' $((s / 86400)) $((s % 86400 / 3600)) $((s % 3600 / 60))
}

split_hp() {  # "host:port" -> HP_HOST HP_PORT
  HP_HOST="${1%:*}"; HP_PORT="${1##*:}"
  [[ $1 == *:* ]] || { HP_HOST=$1; HP_PORT=27017; }
}

# shellcheck disable=SC2016  # $0/$1 expand in the child bash
tcp_open() { timeout 3 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$1" "$2" 2>/dev/null; }

icmp_ok() { command -v ping >/dev/null 2>&1 && ping -c 1 -W 2 "$1" >/dev/null 2>&1; }

detect_shell() {
  if [[ -n $MONGO_SHELL ]]; then
    command -v "$MONGO_SHELL" >/dev/null 2>&1 || return 1
  elif command -v mongosh >/dev/null 2>&1; then MONGO_SHELL=mongosh
  elif command -v mongo >/dev/null 2>&1; then MONGO_SHELL=mongo
  else return 1
  fi
  case "$(basename "$MONGO_SHELL")" in mongosh*) SHELL_KIND=mongosh ;; *) SHELL_KIND=legacy ;; esac
}

# mongo_run HOST PORT JS [USER PASS] -> sets MONGO_OUT, MONGO_ERR, MONGO_RC
mongo_run() {
  local host=$1 port=$2 js=$3 user=${4:-} pass=${5:-}
  local -a args
  if [[ $SHELL_KIND == mongosh ]]; then
    local ms=$((TIMEOUT_SECS * 1000))
    args=("mongodb://${host}:${port}/admin?directConnection=true&serverSelectionTimeoutMS=${ms}&connectTimeoutMS=${ms}" --quiet --norc)
    if (( MONGO_TLS )); then
      args+=(--tls)
      [[ -n $MONGO_TLS_CA ]] && args+=(--tlsCAFile "$MONGO_TLS_CA")
      (( MONGO_TLS_INSECURE )) && args+=(--tlsAllowInvalidCertificates --tlsAllowInvalidHostnames)
    fi
  else
    args=(--quiet --norc --host "$host" --port "$port")
    if (( MONGO_TLS )); then
      args+=(--ssl)
      [[ -n $MONGO_TLS_CA ]] && args+=(--sslCAFile "$MONGO_TLS_CA")
      (( MONGO_TLS_INSECURE )) && args+=(--sslAllowInvalidCertificates --sslAllowInvalidHostnames)
    fi
  fi
  [[ -n $user ]] && args+=(--username "$user" --password "$pass" --authenticationDatabase "$MONGO_AUTH_DB")
  args+=(--eval "$js")
  [[ $SHELL_KIND == legacy ]] && args+=(admin)

  MONGO_OUT="$(timeout $((TIMEOUT_SECS + 10)) "$MONGO_SHELL" "${args[@]}" 2>"$ERR_TMP")"
  MONGO_RC=$?
  MONGO_ERR="$(cat "$ERR_TMP")"
}

# Turn a failed mongo_run into a short reason.
error_reason() {
  local text="$MONGO_OUT $MONGO_ERR"
  if (( MONGO_RC == 124 )); then echo "TIMEOUT"
  elif grep -qiE 'Authentication failed|auth.*fail|requires authentication|not authorized|Unauthorized' <<<"$text"; then echo "AUTH_FAILED"
  elif grep -qiE 'ECONNREFUSED|Connection refused' <<<"$text"; then echo "REFUSED"
  elif grep -qiE 'ENOTFOUND|getaddrinfo|Name or service not known|EAI_' <<<"$text"; then echo "NAME_NOT_RESOLVED"
  elif grep -qiE 'SSL|TLS|certificate' <<<"$text"; then echo "TLS_ERROR"
  elif grep -qiE 'timed out|ETIMEDOUT|EHOSTUNREACH|ServerSelection' <<<"$text"; then echo "TIMEOUT"
  else echo "ERROR"
  fi
}

last_error_line() {
  { echo "$MONGO_ERR"; echo "$MONGO_OUT"; } | grep -v '^[[:space:]]*$' | grep -iE 'error|fail|refused|timed|denied' | head -1 | cut -c1-200
}

# Reachability of one node from this machine: TCP port, then a MongoDB ping
# (ping needs no login, so this also works on auth-enabled servers).
probe_node() {
  local host=$1 port=$2
  tcp_open "$host" "$port" || { echo "PORT_CLOSED"; return 1; }
  mongo_run "$host" "$port" 'print("PING|" + db.adminCommand({ping: 1}).ok)'
  if grep -q '^PING|1' <<<"$MONGO_OUT"; then echo "OK"; return 0; fi
  error_reason; return 1
}

# ---- the JavaScript run on the server --------------------------------------
# Written in ES5 so it runs in both mongosh and the legacy mongo shell. Prints
# pipe-separated lines that the bash code below parses.
read -r -d '' JS_CHECK <<'EOF'
(function () {
  function num(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
    if (typeof v === 'object' && 'floatApprox' in v) return v.floatApprox;
    return Number(v);
  }
  function clean(v) { return (v === undefined || v === null) ? '' : String(v).replace(/[|\r\n]+/g, ' '); }
  function out() {
    var a = [];
    for (var i = 0; i < arguments.length; i++) a.push(clean(arguments[i]));
    print(a.join('|'));
  }
  function cmd(c, quiet) {
    var name = Object.keys(c)[0];
    try {
      var r = db.adminCommand(c);
      if (r && r.ok) return r;
      if (!quiet) out('CMDERR', name, r ? (r.codeName || r.errmsg) : 'no reply');
    } catch (e) {
      if (!quiet) out('CMDERR', name, e.codeName || e.message || e);
    }
    return null;
  }

  var p = cmd({ ping: 1 });
  out('PING', p ? 1 : 0);
  if (!p) return;

  var h = cmd({ hello: 1 }, true) || cmd({ isMaster: 1 }) || {};
  var bi = cmd({ buildInfo: 1 }, true) || {};
  var ss = cmd({ serverStatus: 1, repl: 0, metrics: 0, locks: 0, wiredTiger: 0, tcmalloc: 0 }, true);

  var topo = 'standalone';
  if (h.msg === 'isdbgrid') topo = 'sharded';
  else if (h.setName) topo = 'replicaset';
  else if (h.isreplicaset) topo = 'replicaset-uninitiated';
  var writable = (h.isWritablePrimary || h.ismaster) ? 1 : 0;
  out('TOPO', topo, h.setName || '', h.me || '', writable);
  out('INFO', bi.version || '?', ss ? ss.process : '', ss ? num(ss.uptime) : '',
      ss && ss.connections ? num(ss.connections.current) : '',
      ss && ss.connections ? num(ss.connections.available) : '',
      ss && ss.storageEngine ? ss.storageEngine.name : '');
  if (!ss) out('CMDERR', 'serverStatus', 'not permitted (needs clusterMonitor role)');

  if (topo === 'replicaset') {
    var st = cmd({ replSetGetStatus: 1 });
    if (st) {
      var votes = {};
      var cf = cmd({ replSetGetConfig: 1 }, true);
      if (cf && cf.config) cf.config.members.forEach(function (m) { votes[m.host] = num(m.votes); });
      var prim = null;
      st.members.forEach(function (m) { if (num(m.state) === 1) prim = m; });
      out('RS', st.set, prim ? prim.name : '', st.members.length);
      st.members.forEach(function (m) {
        var lag = '';
        if (prim && num(m.state) === 2 && m.optimeDate && prim.optimeDate)
          lag = Math.max(0, Math.round((prim.optimeDate.getTime() - m.optimeDate.getTime()) / 1000));
        out('MEMBER', m.name, m.stateStr, num(m.health), num(m.uptime), lag, num(m.pingMs),
            votes[m.name] === undefined ? '' : votes[m.name], m.self ? 'self' : '',
            m.lastHeartbeatMessage || m.infoMessage || '');
      });
    }
  }

  if (topo === 'sharded') {
    var ls = cmd({ listShards: 1 });
    if (ls) ls.shards.forEach(function (s) { out('SHARD', s._id, s.host, s.draining ? 'draining' : ''); });
    var sm = cmd({ getShardMap: 1 }, true);
    if (sm && sm.map && sm.map.config) out('CONFIGRS', sm.map.config);
    try {
      var now = (ss && ss.localTime) ? ss.localTime : new Date();
      db.getSiblingDB('config').mongos.find().sort({ _id: 1 }).toArray().forEach(function (m) {
        out('MONGOS', m._id, m.ping ? Math.round((now.getTime() - m.ping.getTime()) / 1000) : '',
            num(m.up), m.mongoVersion || '');
      });
    } catch (e) { out('CMDERR', 'config.mongos', e.message || e); }
    var bs = cmd({ balancerStatus: 1 }, true);
    if (bs) out('BALANCER', bs.mode, bs.inBalancerRound ? 1 : 0);
  }
})();
EOF

# ---- reports ---------------------------------------------------------------
log_cmd_errors() {  # $1 = label, $2 = output
  local _ name msg
  while IFS='|' read -r _ name msg; do
    log "  note: $1: command '$name' failed: $msg"
  done < <(grep '^CMDERR|' <<<"$2")
}

report_node_info() {  # $1 = node, $2 = output
  local _ ver proc up cur avail eng
  IFS='|' read -r _ ver proc up cur avail eng <<<"$(grep -m1 '^INFO|' <<<"$2")"
  log "  Node         : $1"
  log "  Process      : ${proc:-?}   Version: ${ver:-?}   Storage engine: ${eng:--}"
  log "  Uptime       : $(fmt_uptime "${up:-}")"
  log "  Connections  : current ${cur:--}, available ${avail:--}"
  if [[ $cur =~ ^[0-9]+$ && $avail =~ ^[0-9]+$ ]] && (( cur + avail > 0 && avail * 10 < cur + avail )); then
    raise 1 "$1: less than 10% of connections left ($avail available)"
  fi
}

# Replica set table from replSetGetStatus output. $1 = label, $2 = output
report_rs() {
  local label=$1 out=$2 _ rs_name primary count
  if ! grep -q '^RS|' <<<"$out"; then
    raise 2 "$label: could not read replica set status"
    log_cmd_errors "$label" "$out"
    return
  fi
  IFS='|' read -r _ rs_name primary count <<<"$(grep -m1 '^RS|' <<<"$out")"
  log "  Replica set  : $rs_name   members: $count   primary: ${primary:-NONE}"
  [[ -z $primary ]] && raise 2 "$label ($rs_name): NO PRIMARY - writes are not possible"

  log ""
  log "$(printf '  %-24s %-11s %-7s %-14s %-7s %-6s %-5s %-18s %s' NODE STATE HEALTH UPTIME 'LAG(s)' PING VOTES 'FROM-THIS-HOST' RESULT)"
  local name state health up lag ping votes self note direct result vsum=0 vup=0
  while IFS='|' read -r _ name state health up lag ping votes self note; do
    result="OK"
    case "$state" in
      PRIMARY|SECONDARY|ARBITER) ;;
      STARTUP|STARTUP2|RECOVERING|ROLLBACK) result="WARNING"; raise 1 "$label: $name is $state" ;;
      *) result="CRITICAL"; raise 2 "$label: $name is $state${note:+ ($note)}" ;;
    esac
    if [[ $health != 1 ]]; then
      result="CRITICAL"
      [[ $state =~ ^(DOWN|UNKNOWN|\(not reachable/healthy\))$ ]] || raise 2 "$label: $name is unhealthy${note:+ ($note)}"
    fi
    if [[ $lag =~ ^[0-9]+$ ]]; then
      if (( lag >= LAG_CRIT_SECS )); then result="CRITICAL"; raise 2 "$label: $name is ${lag}s behind the primary"
      elif (( lag >= LAG_WARN_SECS )); then [[ $result == OK ]] && result="WARNING"; raise 1 "$label: $name is ${lag}s behind the primary"
      fi
    fi

    direct="-"
    if (( DIRECT_PROBE )); then
      split_hp "$name"
      direct="$(probe_node "$HP_HOST" "$HP_PORT")"
      if [[ $direct != OK && $health == 1 ]]; then
        [[ $result == OK ]] && result="WARNING"
        raise 1 "$label: $name is healthy in the cluster but not reachable from this host ($direct)"
      fi
    fi

    [[ -z $votes ]] && votes=1
    vsum=$((vsum + votes))
    [[ $health == 1 ]] && vup=$((vup + votes))

    log "$(printf '  %-24s %-11s %-7s %-14s %-7s %-6s %-5s %-18s %s' \
      "$name${self:+*}" "$state" "$health" "$(fmt_uptime "$up")" "${lag:--}" "${ping:+${ping}ms}" "$votes" "$direct" "$result")"
    [[ -n $note ]] && log "      message: $note"
  done < <(grep '^MEMBER|' <<<"$out")
  log "  (* = node the check was run against)"

  if (( vsum > 0 && vup < vsum / 2 + 1 )); then
    raise 2 "$label ($rs_name): only $vup of $vsum votes healthy - majority lost, no primary can be elected"
  fi
  log_cmd_errors "$label" "$out"
}

# Check a replica set given its connection string "setName/host:port,host:port".
check_rs_connstr() {
  local label=$1 connstr=$2 set hosts hp reasons=()
  set="${connstr%%/*}"; hosts="${connstr#*/}"
  local user=${SHARD_USER:-$MONGO_USER} pass=${SHARD_USER:+$SHARD_PASS}
  [[ -z $SHARD_USER ]] && pass=$MONGO_PASS
  local -a list
  IFS=, read -ra list <<<"$hosts"
  for hp in "${list[@]}"; do
    split_hp "$hp"
    mongo_run "$HP_HOST" "$HP_PORT" "$JS_CHECK" "$user" "$pass"
    if grep -q '^PING|1' <<<"$MONGO_OUT"; then
      report_rs "$label" "$MONGO_OUT"
      return
    fi
    reasons+=("$hp=$(error_reason)")
  done
  raise 2 "$label ($set): none of its members could be queried (${reasons[*]})"
  log "  Could not query $set: ${reasons[*]}"
  if [[ " ${reasons[*]} " == *AUTH_FAILED* ]]; then
    log "  Hint: shards need a shard-local user; set SHARD_USER/SHARD_PASS in the config file."
  fi
  for hp in "${list[@]}"; do
    split_hp "$hp"
    log "$(printf '  %-24s from this host: %s' "$hp" "$(probe_node "$HP_HOST" "$HP_PORT")")"
  done
}

# ---- main ------------------------------------------------------------------
section "MongoDB health check"
log "Target       : $SEED_IP:$SEED_PORT"
log "Run from     : $(hostname 2>/dev/null || echo '?')"
log "Log file     : $LOG_FILE"
[[ -f $CONFIG_FILE ]] && log "Config file  : $CONFIG_FILE"
log "Auth         : ${MONGO_USER:-none} $([[ -n $MONGO_USER ]] && echo "(auth db: $MONGO_AUTH_DB)")"

TOPOLOGY="unknown"
finish() {
  section "Summary"
  log "Topology     : $TOPOLOGY"
  if (( ${#ISSUES[@]} == 0 )); then
    log "Issues       : none"
  else
    local i; for i in "${ISSUES[@]}"; do log "  - $i"; done
  fi
  log "OVERALL STATUS: $(sev_name "$OVERALL")"
  echo "$(date '+%Y-%m-%d %H:%M:%S') | $SEED_IP:$SEED_PORT | $(sev_name "$OVERALL") | $TOPOLOGY | ${#ISSUES[@]} issue(s) | $LOG_FILE" >>"$HISTORY_FILE"
  exit "$OVERALL"
}

if ! detect_shell; then
  raise 3 "no MongoDB shell found - install mongosh (or the legacy mongo shell) on this machine"
  OVERALL=3; finish
fi
log "Client       : $MONGO_SHELL ($("$MONGO_SHELL" --version 2>/dev/null | head -1))"

section "Step 1: network reachability"
if icmp_ok "$SEED_IP"; then log "  ICMP ping    : reply"; else log "  ICMP ping    : no reply (may just be blocked by a firewall)"; fi
if tcp_open "$SEED_IP" "$SEED_PORT"; then
  log "  TCP port $SEED_PORT : open"
else
  log "  TCP port $SEED_PORT : CLOSED / unreachable"
  raise 2 "$SEED_IP:$SEED_PORT - port not reachable (mongod not running, wrong port, bindIp or firewall)"
  finish
fi

section "Step 2: connect and ping MongoDB"
mongo_run "$SEED_IP" "$SEED_PORT" "$JS_CHECK" "$MONGO_USER" "$MONGO_PASS"
if ! grep -q '^PING|1' <<<"$MONGO_OUT"; then
  reason="$(error_reason)"
  log "  Result       : FAILED ($reason)"
  detail="$(last_error_line)"; [[ -n $detail ]] && log "  Error        : $detail"
  if [[ $reason == AUTH_FAILED ]]; then
    log "  Hint         : set MONGO_USER / MONGO_PASS in $CONFIG_FILE"
  fi
  raise 2 "$SEED_IP:$SEED_PORT - MongoDB did not answer ($reason)"
  finish
fi
log "  Result       : MongoDB is responding"

IFS='|' read -r _ TOPOLOGY SET_NAME ME WRITABLE <<<"$(grep -m1 '^TOPO|' <<<"$MONGO_OUT")"
SEED_OUT="$MONGO_OUT"

section "Step 3: deployment type"
case "$TOPOLOGY" in
  standalone)             log "  Detected     : STANDALONE server" ;;
  replicaset)             log "  Detected     : REPLICA SET '$SET_NAME' (this node: ${ME:-$SEED_IP:$SEED_PORT})" ;;
  sharded)                log "  Detected     : SHARDED CLUSTER (connected to a mongos router)" ;;
  replicaset-uninitiated) log "  Detected     : started as a replica set member, but the replica set is NOT initiated" ;;
esac

section "Step 4: node status"
case "$TOPOLOGY" in
  standalone)
    report_node_info "$SEED_IP:$SEED_PORT" "$SEED_OUT"
    if [[ $WRITABLE == 1 ]]; then log "  Status       : UP, accepting writes"
    else log "  Status       : UP but NOT writable"; raise 1 "$SEED_IP:$SEED_PORT is not accepting writes"
    fi
    log_cmd_errors "$SEED_IP:$SEED_PORT" "$SEED_OUT"
    ;;
  replicaset-uninitiated)
    report_node_info "$SEED_IP:$SEED_PORT" "$SEED_OUT"
    raise 2 "$SEED_IP:$SEED_PORT runs with --replSet but rs.initiate() has not been run"
    ;;
  replicaset)
    report_node_info "${ME:-$SEED_IP:$SEED_PORT}" "$SEED_OUT"
    log ""
    report_rs "replica set $SET_NAME" "$SEED_OUT"
    ;;
  sharded)
    report_node_info "$SEED_IP:$SEED_PORT (mongos)" "$SEED_OUT"

    log ""
    log "  -- Router (mongos) instances --"
    log "$(printf '  %-24s %-16s %-14s %-9s %-18s %s' NODE LAST-PING UPTIME VERSION FROM-THIS-HOST RESULT)"
    while IFS='|' read -r _ name age up ver; do
      [[ $age =~ ^[0-9]+$ ]] || age=999999
      (( age > 86400 )) && continue        # old entry of a decommissioned mongos
      split_hp "$name"
      direct="-"; (( DIRECT_PROBE )) && direct="$(probe_node "$HP_HOST" "$HP_PORT")"
      if (( age <= 120 )); then result="OK"; else result="CRITICAL"; raise 2 "mongos $name has not checked in for ${age}s"; fi
      if [[ $result == OK && $direct != OK && $direct != - ]]; then result="WARNING"; raise 1 "mongos $name not reachable from this host ($direct)"; fi
      log "$(printf '  %-24s %-16s %-14s %-9s %-18s %s' "$name" "${age}s ago" "$(fmt_uptime "$up")" "$ver" "$direct" "$result")"
    done < <(grep '^MONGOS|' <<<"$SEED_OUT")

    IFS='|' read -r _ bmode bround <<<"$(grep -m1 '^BALANCER|' <<<"$SEED_OUT")"
    [[ -n ${bmode:-} ]] && log "  Balancer     : mode=$bmode$([[ ${bround:-0} == 1 ]] && echo ', balancing now')"
    log_cmd_errors "mongos" "$SEED_OUT"

    cfg="$(grep -m1 '^CONFIGRS|' <<<"$SEED_OUT" | cut -d'|' -f2)"
    if [[ -n $cfg ]]; then
      log ""
      log "  -- Config server replica set --"
      check_rs_connstr "config servers" "$cfg"
    fi

    while IFS='|' read -r _ sid shost sflag; do
      log ""
      log "  -- Shard $sid${sflag:+ ($sflag)} --"
      if [[ $shost == */* ]]; then
        check_rs_connstr "shard $sid" "$shost"
      else
        split_hp "$shost"
        r="$(probe_node "$HP_HOST" "$HP_PORT")"
        log "  $shost (standalone shard) from this host: $r"
        [[ $r == OK ]] || raise 2 "shard $sid ($shost) is not reachable ($r)"
      fi
    done < <(grep '^SHARD|' <<<"$SEED_OUT")
    ;;
esac

finish
