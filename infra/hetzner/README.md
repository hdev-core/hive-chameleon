# Hetzner live game

The live stack serves one credential-neutral Unity WebGL artifact at
`https://hive-signer.cloverapis.xyz/game/`. Every browser obtains an isolated guest player and
revocable session from the API before Unity starts. The same TLS virtual host proxies the API,
Nakama REST/WebSocket endpoints, and the pre-existing signer boundary.

The Compose stack keeps both PostgreSQL databases private and exposes the API and Nakama only on
loopback. Nginx is the only public game entry point. Runtime database users inherit only the
repository-managed `hc_api` and `hc_nakama` permission groups. The API reaches Nakama over the
private Compose network; only the browser-facing WebSocket URL leaves that network and requires
TLS.

Production secrets belong in `/etc/hive-chameleon/game.env` on the server with mode `0600`. Start
or update the backend from `/opt/hive-chameleon/current`:

```bash
docker compose --env-file /etc/hive-chameleon/game.env \
  -f infra/hetzner/compose.yaml up -d --build --remove-orphans
```

The static artifact is copied to `/srv/hive-chameleon/game`. Never put an access token, refresh
token, database password, bridge key, signer token, or private key into that directory. The only
client-readable runtime value besides the public origin is Nakama's public server key.

`hive-chameleon-backup.timer` creates daily custom-format dumps for both databases and retains
seven days under `/var/backups/hive-chameleon`. These same-host dumps protect against application
and migration mistakes; a Hetzner snapshot or external encrypted backup is still required for host
or disk loss.
