# Custom DSH plugin index

DSH has no official public plugin index. This directory is a **custom index** for the
experimental Plugin Market/Discover tab. It is served as a plain JSON file over HTTPS.

## Index URL

After pushing this repository to GitHub `main`:

```text
https://raw.githubusercontent.com/DannielZhang/dsh-git-branch-graph/main/market/index.json
```

Add it in DSH:

1. Open **Plugins** in the Web sidebar.
2. Enable **Experimental plugins → Custom plugin indexes** if it is off.
3. Open **Discover** and add the index URL above.
4. Open **Git branch graph** and install version `1.3.0`.

The install source is the Git commit pinned in `index.json`, not the mutable `main`
branch. Every release must update:

- `package.json` `version`
- the version, `publishTimestamp`, and source `commit` in `market/index.json`
- the plugin's `meta.detail`/locale files if they changed

## Release checklist

```sh
npm run check
npm pack --dry-run
git add -A
git commit -m "Release 1.3.0"
git rev-parse HEAD
```

Put the new commit SHA into `market/index.json`, commit that update, then push both
commits. Finally validate the index with the installed DSH runtime:

```sh
ELECTRON_RUN_AS_NODE=1 \
  "$DSH_NODE_EXECUTABLE" \
  -e "const fs=require('node:fs'); \
      const mod=require(require.resolve('@deepseek-ai/dsh-plugin-market-index', \
        {paths:[process.env.DSH_INSTALL_DIR]})); \
      console.log(mod.parseMarketIndex(JSON.parse(fs.readFileSync(process.argv[1],'utf8')), \
      'https://raw.githubusercontent.com/DannielZhang/dsh-git-branch-graph/main/market/index.json'))" \
  market/index.json
```

The index must stay valid for the DSH version it targets. The repository is public and
the bundle is MIT-licensed.
