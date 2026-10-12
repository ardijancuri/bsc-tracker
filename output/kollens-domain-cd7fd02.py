from pathlib import Path
import re
import shutil
import subprocess
import sys

config = Path('/opt/borders/shared/Caddyfile.bonfire')
backup = Path('/opt/bscan/deploy/rollback-domain-cd7fd02')
backup.mkdir(mode=0o700, parents=True, exist_ok=True)
old = config.read_text()
if not (backup / 'Caddyfile').exists():
    shutil.copy2(config, backup / 'Caddyfile')

mode = sys.argv[1]
if mode == 'prepare':
    if re.search(r'^kollens\.com\s*\{', old, re.M):
        raise SystemExit('kollens.com already configured; inspect before proceeding')
    new = old + '''

# Kollens primary domain, added 2026-10-12.
kollens.com {
    tls {
        issuer acme https://acme-v02.api.letsencrypt.org/directory {
            disable_http_challenge
        }
    }
    encode zstd gzip
    reverse_proxy 127.0.0.1:3300
}

www.kollens.com {
    tls {
        issuer acme https://acme-v02.api.letsencrypt.org/directory {
            disable_http_challenge
        }
    }
    redir https://kollens.com{uri} 308
}

http://kollens.com, http://www.kollens.com {
    redir https://kollens.com{uri} 308
}
'''
elif mode == 'activate':
    start = old.index('\nbscan.fun {')
    end = old.index('\nwww.bscan.fun {', start)
    block = old[start:end]
    needle = '    encode zstd gzip\n    reverse_proxy 127.0.0.1:3300'
    if block.count(needle) != 1:
        raise SystemExit('Unexpected old domain configuration')
    block = block.replace(needle, '    redir https://kollens.com{uri} 308')
    new = old[:start] + block + old[end:]
    if new.count('redir https://bscan.fun{uri} 308') != 2:
        raise SystemExit('Unexpected old www/HTTP redirects')
    new = new.replace('redir https://bscan.fun{uri} 308', 'redir https://kollens.com{uri} 308')
else:
    raise SystemExit('Expected prepare or activate')

config.write_text(new)
try:
    subprocess.run(['docker', 'exec', 'borders-vps-proxy-1', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], check=True)
    subprocess.run(['docker', 'kill', '--signal=USR1', 'borders-vps-proxy-1'], check=True)
except Exception:
    config.write_text(old)
    subprocess.run(['docker', 'kill', '--signal=USR1', 'borders-vps-proxy-1'], check=True)
    raise
print('Kollens domain configuration:', mode)
