# Draft: collaborator notice

**Subject:** `main` history was rewritten; please refresh your clone

Hi,

I force-pushed `main` after removing old Firebase config paths and exposed
Firebase web API key strings from reachable Git history. Please do not merge
your old local `main` into the rewritten branch.

The simplest option is to make a fresh clone. If you need to keep local work,
back it up first, then fetch the new history and reset only after confirming
the backup is safe:

```sh
git fetch origin
git checkout main
git reset --hard origin/main
```

`git reset --hard` discards uncommitted changes on the checked-out branch. Do
not run `git clean` as part of this refresh; it can delete untracked local files
such as databases. Rebase any feature branch based on the old `main` onto the
rewritten `origin/main` before proposing it.

The history cleanup does not remove copies already present in clones or forks.
Firebase console access was unavailable during cleanup, so rotation and
restriction of any exposed keys is still pending. Please delete any old local
copies of the affected config or keys, and do not reuse them. The app now uses
SQLite; Firebase is disconnected.

Runtime checks require Node.js 22.13 or newer. From a fresh clone, run:

```sh
npm install
npm start
```

This is a draft only; it has not been sent.
