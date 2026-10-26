# MongoDB node status check

`mongo_health_check.sh` asks for the IP of a MongoDB server, works out whether it is a
standalone server, a replica set or a sharded cluster, and prints the status of every
node. Everything the script prints is also saved to a log file for that run.

## Requirements (on the machine that runs the check)

- bash and coreutils (`timeout`)
- `mongosh`, or the legacy `mongo` shell. Install it from the offline package/tarball.
- Network access to the MongoDB port (default 27017) of every node.

No internet access is needed.

## Run

```bash
./mongo_health_check.sh                 # prompts: Enter MongoDB server IP:
./mongo_health_check.sh 192.168.1.50    # no prompt (for cron)
./mongo_health_check.sh 192.168.1.50:27018
```

Example output (also written to `logs/mongo_health_192.168.1.50_20261026_103000.log`):

```
2026-10-26 10:30:00 MongoDB status check started - target 192.168.1.50:27017
2026-10-26 10:30:00 Log file: .../logs/mongo_health_192.168.1.50_20261026_103000.log
2026-10-26 10:30:00 Server: UP (port 27017 open)
2026-10-26 10:30:01 Deployment: REPLICA SET (rs0)
2026-10-26 10:30:01 NODE                     ROLE           STATUS REMARK
2026-10-26 10:30:01 192.168.1.50:27017       PRIMARY        UP
2026-10-26 10:30:01 192.168.1.51:27017       SECONDARY      UP
2026-10-26 10:30:01 192.168.1.52:27017       -              DOWN   Error connecting to 192.168.1.52:27017 ...
2026-10-26 10:30:01 Nodes: 3 checked, 2 up, 1 down
2026-10-26 10:30:01 MongoDB status check finished
```

## What it does

1. Asks for the IP and checks that it is a valid IPv4 address.
2. Opens a log file in `logs/` and copies everything it prints into it.
3. Tests the MongoDB port. *Connection refused* means the server is up but MongoDB is
   not running. No answer means the server is down or unreachable, or, if the server
   still answers ping, that MongoDB is hung or blocked by a firewall. Then it connects
   and runs `ping`.
4. Detects the deployment type with the `hello` command:
   - **Standalone**: one row for the server.
   - **Replica set**: one row per member from `rs.status()` (PRIMARY / SECONDARY /
     ARBITER / DOWN ...).
   - **Sharded cluster** (the IP is a mongos): rows for every mongos router, the config
     server replica set and each shard's members.
5. Prints a summary line and exits with a status code.

| Exit code | Meaning |
|---|---|
| 0 | all nodes up |
| 1 | at least one node down |
| 2 | the server at the given IP is down or refused the connection |
| 3 | cannot run (invalid IP, no MongoDB shell installed) |

Logs older than 30 days are deleted automatically.

## Login, TLS, port

If MongoDB has authentication or TLS enabled, copy `mongo_health_check.conf.example` to
`mongo_health_check.conf` and fill it in. The script still asks only for the IP.

## Schedule with cron

```
*/15 * * * * /opt/mongo-check/mongo_health_check.sh 192.168.1.50 >/dev/null 2>&1
```

## Checking by hand

```bash
mongosh --host 192.168.1.50 --port 27017 --eval 'db.adminCommand({ping:1})'
mongosh --host 192.168.1.50 --eval 'db.hello()'           # setName = replica set, msg "isdbgrid" = mongos
mongosh --host 192.168.1.50 --eval 'rs.status().members.forEach(m => print(m.name, m.stateStr, m.health))'
mongosh --host 192.168.1.50 --eval 'sh.status()'          # sharded cluster
```
