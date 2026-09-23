kv = {}
for l in open('/home/codex/code/ai-chat-platform/repo/.env', encoding='utf-8'):
    l = l.strip()
    if l and not l.startswith('#'):
        k, _, v = l.partition('=')
        kv[k] = v
pw = kv['POSTGRES_PASSWORD'].replace("'", "'\\''").replace('@', '%40')
print('export DATABASE_URL=postgresql://' + kv['POSTGRES_USER'] + ':' + pw + '@127.0.0.1:5433/' + kv['POSTGRES_DB'])
for k in ('S3_ENDPOINT', 'S3_BUCKET', 'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD', 'OLLAMA_BASE_URL', 'EMBEDDING_MODEL', 'RAG_HYBRID', 'RAG_RERANK', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'):
    if k in kv:
        print(f"export {k}='{kv[k]}'")
