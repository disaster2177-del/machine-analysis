#!/usr/bin/env bash
#
# mongo_health_check.sh - show the status of every MongoDB node behind one IP
# (standalone server, replica set or sharded cluster) and save the run to a log.
#
# Usage:
#   ./mongo_health_check.sh                 # asks for the server IP
#   ./mongo_health_check.sh 192.168.1.50    # IP given up front (for cron)
#   ./mongo_health_check.sh 192.168.1.50:27018
#
# Needs bash and a MongoDB shell (mongosh, or the legacy "mongo") on this
# machine; no internet. Login/TLS, if used, go in mongo_health_check.conf.
#
# Each run writes everything it prints to logs/mongo_health_<ip>_<time>.log.
# Exit codes: 0 all nodes up, 1 some nodes down, 2 server down, 3 cannot run

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
MONGO_TLS_INSECURE=0          # 1 = accept self-signed certificates
MONGO_SHELL=""                # empty = mongosh, else mongo
TIMEOUT_SECS=10               # per connection attempt
LOG_DIR="$SCRIPT_DIR/logs"
LOG_RETENTION_DAYS=30

CONFIG_FILE="${MONGO_HEALTH_CONF:-$SCRIPT_DIR/mongo_health_check.conf}"
# shellcheck source=/dev/null
[[ -f $CONFIG_FILE ]] && source "$CONFIG_FILE"

# ---- input: the server IP -------------------------------------------------
TARGET="${1:-}"
if [[ $TARGET == -h || $TARGET == --help ]]; then
  sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0
fi
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
  local o
  [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for o in "${BASH_REMATCH[@]:1}"; do (( 10#$o <= 255 )) || return 1; done
}
if ! valid_ip "$SEED_IP"; then echo "Invalid IP address: '$SEED_IP'" >&2; exit 3; fi
if ! [[ $SEED_PORT =~ ^[0-9]+$ ]] || (( SEED_PORT < 1 || SEED_PORT > 65535 )); then
  echo "Invalid port: '$SEED_PORT'" >&2; exit 3
fi

# ---- log file: a copy of everything this run prints ------------------------
mkdir -p "$LOG_DIR" || { echo "Cannot create log directory $LOG_DIR" >&2; exit 3; }
find "$LOG_DIR" -maxdepth 1 -name 'mongo_health_*.log' -mtime +"$LOG_RETENTION_DAYS" -delete 2>/dev/null
LOG_FILE="$LOG_DIR/mongo_health_${SEED_IP}_$(date '+%Y%m%d_%H%M%S').log"
[[ -e $LOG_FILE ]] && LOG_FILE="${LOG_FILE%.log}_$$.log"
exec > >(tee -a "$LOG_FILE") 2>&1

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

ERR_TMP="$(mktemp)"
trap 'rm -f "$ERR_TMP"' EXIT

# ---- helpers ---------------------------------------------------------------
NODES_TOTAL=0
NODES_DOWN=0
node_row() {  # node role status [reason]
  NODES_TOTAL=$((NODES_TOTAL + 1))
  [[ $3 == UP ]] || NODES_DOWN=$((NODES_DOWN + 1))
  log "$(printf '%-24s %-14s %-6s %s' "$1" "$2" "$3" "${4:-}")"
}
table_header() { log "$(printf '%-24s %-14s %-6s %s' NODE ROLE STATUS REMARK)"; }

split_hp() {  # "host:port" -> HP_HOST HP_PORT
  HP_HOST="${1%:*}"; HP_PORT="${1##*:}"
  [[ $1 == *:* ]] || { HP_HOST=$1; HP_PORT=27017; }
}

# shellcheck disable=SC2016  # $0/$1 expand in the child bash
tcp_open() { timeout 3 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$1" "$2" 2>/dev/null; }

# OPEN, REFUSED (host is up, nothing listening on the port) or NO_ANSWER.
# shellcheck disable=SC2016
tcp_state() {
  local err
  err="$(timeout 3 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$1" "$2" 2>&1)"
  case $? in
    0) echo OPEN ;;
    124) echo NO_ANSWER ;;
    *) if grep -qi 'refused' <<<"$err"; then echo REFUSED; else echo NO_ANSWER; fi ;;
  esac
}

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

# Short reason for a failed mongo_run.
error_reason() {
  local text="$MONGO_OUT $MONGO_ERR"
  if (( MONGO_RC == 124 )); then echo "timeout"
  elif grep -qiE 'Authentication failed|auth.*fail|requires authentication|not authorized|Unauthorized' <<<"$text"; then echo "login failed"
  elif grep -qiE 'ECONNREFUSED|Connection refused' <<<"$text"; then echo "connection refused"
  elif grep -qiE 'ENOTFOUND|getaddrinfo|Name or service not known|EAI_' <<<"$text"; then echo "name not resolved"
  elif grep -qiE 'SSL|TLS|certificate' <<<"$text"; then echo "TLS error"
  elif grep -qiE 'timed out|ETIMEDOUT|EHOSTUNREACH|ServerSelection' <<<"$text"; then echo "timeout"
  else echo "error"
  fi
}

# ---- the JavaScript run on the server --------------------------------------
# ES5 so it runs in both mongosh and the legacy mongo shell. Prints
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
  function cmd(c) {
    try { var r = db.adminCommand(c); if (r && r.ok) return r; } catch (e) {}
    return null;
  }

  if (!cmd({ ping: 1 })) { out('PING', 0); return; }
  out('PING', 1);

  var h = cmd({ hello: 1 }) || cmd({ isMaster: 1 }) || {};
  var topo = 'standalone';
  if (h.msg === 'isdbgrid') topo = 'sharded';
  else if (h.setName) topo = 'replicaset';
  else if (h.isreplicaset) topo = 'replicaset-uninitiated';
  out('TOPO', topo, h.setName || '', h.me || '');

  if (topo === 'replicaset') {
    var st = cmd({ replSetGetStatus: 1 });
    if (!st) { out('ERR', 'replSetGetStatus not permitted (needs clusterMonitor role)'); return; }
    st.members.forEach(function (m) {
      out('MEMBER', m.name, m.stateStr, num(m.health), m.lastHeartbeatMessage || '');
    });
  }

  if (topo === 'sharded') {
    var ss = cmd({ serverStatus: 1, repl: 0, metrics: 0, locks: 0, wiredTiger: 0 });
    var now = (ss && ss.localTime) ? ss.localTime : new Date();
    try {
      db.getSiblingDB('config').mongos.find().sort({ _id: 1 }).toArray().forEach(function (m) {
        out('MONGOS', m._id, m.ping ? Math.round((now.getTime() - m.ping.getTime()) / 1000) : '');
      });
    } catch (e) {}
    var sm = cmd({ getShardMap: 1 });
    if (sm && sm.map && sm.map.config) out('CONFIGRS', sm.map.config);
    var ls = cmd({ listShards: 1 });
    if (!ls) { out('ERR', 'listShards not permitted (needs clusterMonitor role)'); return; }
    ls.shards.forEach(function (s) { out('SHARD', s._id, s.host); });
  }
})();
EOF

# Rows for a replica set read from replSetGetStatus output. $1 = output
rs_rows() {
  local _ name state health msg
  while IFS='|' read -r _ name state health msg; do
    if [[ $health == 1 ]]; then node_row "$name" "$state" UP
    else
      [[ $state == *"not reachable"* ]] && state="-"
      node_row "$name" "$state" DOWN "$msg"
    fi
  done < <(grep '^MEMBER|' <<<"$1")
}

# Rows for a replica set given as "setName/host:port,host:port" (shards and
# config servers): ask the first member that answers for the set's status.
rs_rows_from_connstr() {
  local set="${1%%/*}" hp reason=""
  local user=${SHARD_USER:-$MONGO_USER} pass=$MONGO_PASS
  [[ -n $SHARD_USER ]] && pass=$SHARD_PASS
  local -a list
  IFS=, read -ra list <<<"${1#*/}"
  for hp in "${list[@]}"; do
    split_hp "$hp"
    mongo_run "$HP_HOST" "$HP_PORT" "$JS_CHECK" "$user" "$pass"
    if grep -q '^MEMBER|' <<<"$MONGO_OUT"; then rs_rows "$MONGO_OUT"; return; fi
    reason="$(error_reason)"
  done
  for hp in "${list[@]}"; do node_row "$hp" "$set member" DOWN "could not query ($reason)"; done
}

# ---- main ------------------------------------------------------------------
log "MongoDB status check started - target $SEED_IP:$SEED_PORT"
log "Log file: $LOG_FILE"

finish() {  # $1 = exit code
  log "Nodes: $NODES_TOTAL checked, $((NODES_TOTAL - NODES_DOWN)) up, $NODES_DOWN down"
  log "MongoDB status check finished"
  exit "$1"
}

if ! detect_shell; then
  log "ERROR: no MongoDB shell found - install mongosh (or the legacy mongo shell) on this machine"
  finish 3
fi

case "$(tcp_state "$SEED_IP" "$SEED_PORT")" in
  OPEN)
    log "Server: UP (port $SEED_PORT open)" ;;
  REFUSED)
    log "Server: UP (connection to port $SEED_PORT refused)"
    log "Deployment: unknown"
    table_header
    node_row "$SEED_IP:$SEED_PORT" "-" DOWN "MongoDB is not running on port $SEED_PORT"
    finish 2 ;;
  *)
    if icmp_ok "$SEED_IP"; then
      log "Server: UP (answers ping)"
      remark="MongoDB port $SEED_PORT not answering (mongod down/hung or firewall)"
    else
      log "Server: DOWN or unreachable (no ping reply, port $SEED_PORT not answering)"
      remark="server not reachable"
    fi
    log "Deployment: unknown"
    table_header
    node_row "$SEED_IP:$SEED_PORT" "-" DOWN "$remark"
    finish 2 ;;
esac

mongo_run "$SEED_IP" "$SEED_PORT" "$JS_CHECK" "$MONGO_USER" "$MONGO_PASS"
if ! grep -q '^PING|1' <<<"$MONGO_OUT"; then
  log "Deployment: unknown"
  table_header
  node_row "$SEED_IP:$SEED_PORT" "-" DOWN "$(error_reason)"
  finish 2
fi

IFS='|' read -r _ TOPOLOGY SET_NAME _ <<<"$(grep -m1 '^TOPO|' <<<"$MONGO_OUT")"
SEED_OUT="$MONGO_OUT"

case "$TOPOLOGY" in
  standalone)
    log "Deployment: STANDALONE"
    table_header
    node_row "$SEED_IP:$SEED_PORT" STANDALONE UP
    ;;
  replicaset-uninitiated)
    log "Deployment: REPLICA SET (not initiated - rs.initiate() was never run)"
    table_header
    node_row "$SEED_IP:$SEED_PORT" "NOT INITIATED" UP
    ;;
  replicaset)
    log "Deployment: REPLICA SET ($SET_NAME)"
    table_header
    rs_rows "$SEED_OUT"
    ;;
  sharded)
    log "Deployment: SHARDED CLUSTER"
    table_header
    while IFS='|' read -r _ name age; do
      [[ $age =~ ^[0-9]+$ ]] || age=999999
      (( age > 86400 )) && continue        # old entry of a decommissioned mongos
      if (( age <= 120 )); then node_row "$name" "MONGOS" UP
      else node_row "$name" "MONGOS" DOWN "no check-in for ${age}s"
      fi
    done < <(grep '^MONGOS|' <<<"$SEED_OUT")
    cfg="$(grep -m1 '^CONFIGRS|' <<<"$SEED_OUT" | cut -d'|' -f2)"
    if [[ -n $cfg ]]; then
      log "Config servers:"
      rs_rows_from_connstr "$cfg"
    fi
    while IFS='|' read -r _ sid shost; do
      log "Shard $sid:"
      if [[ $shost == */* ]]; then
        rs_rows_from_connstr "$shost"
      else
        split_hp "$shost"
        if tcp_open "$HP_HOST" "$HP_PORT"; then node_row "$shost" STANDALONE UP
        else node_row "$shost" STANDALONE DOWN "port not reachable"
        fi
      fi
    done < <(grep '^SHARD|' <<<"$SEED_OUT")
    ;;
esac

grep '^ERR|' <<<"$SEED_OUT" | cut -d'|' -f2 | while read -r e; do log "ERROR: $e"; done

if (( NODES_DOWN > 0 )); then finish 1; fi
finish 0
