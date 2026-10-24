# bwenstar.github.io

Personal site for [Brendan Ta](https://github.com/bwenstar), served by GitHub Pages
at <https://brendanta.com> (see `CNAME`). Jekyll, no theme gem — the layouts and CSS
in this repo are the whole design.

## How it's published

GitHub Pages builds the site itself from the `master` branch (Settings → Pages →
"Deploy from a branch"), using GitHub's built-in Jekyll 3.10 with no extra plugins.
Push to `master` and it's live a minute later. Keep templates compatible with that:
plain Liquid, no plugins.

`.github/workflows/deploy.yml` does **not** run: it triggers on a `main` branch, and
this repo's branch is `master`. It's left in place, unused.

## Running it locally

```bash
bundle install
bundle exec jekyll serve      # http://127.0.0.1:4000
```

Or, with no Ruby installed, build with the same Jekyll version GitHub uses:

```bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e JEKYLL_NO_BUNDLER_REQUIRE=true \
  -v "$PWD:/srv/jekyll:ro" -v "$PWD/_site:/out" -w /tmp \
  jekyll/jekyll:pages jekyll build --source /srv/jekyll --destination /out --safe
python3 -m http.server -d _site 4000
```

`Gemfile` pins plain `jekyll` 4 (not the `github-pages` gem) because nothing here uses
a plugin. `JEKYLL_NO_BUNDLER_REQUIRE` stops the Docker image from trying to load it.

## Layout

| Path | What it is |
|------|------------|
| `_config.yml` | Site settings. `projects:` drives the project cards on the home page and the list on About. Add an entry there rather than editing `index.html`. Each project has `name`, `kicker`, `blurb`, `image`, `url`, `tags` and `links` (see the comment in the file). |
| `assets/img/projects/` | Card images: 16:10, 960×600 WebP. They're screenshots with no player names: the tennis competition list, the matchcentre demo club's ladder, and the go card dashboard with its fictional example data. |
| `_layouts/` | `default` (shell), `post`, `tag_posts`. |
| `_includes/` | `head`, `header` (nav, GitHub link, theme toggle), `footer`, `tag-cloud`, `gallery-content`. |
| `_posts/` | Blog posts, `YYYY-MM-DD-slug.md`. |
| `_data/gallery.yml` | Gallery image list (filename, title, tags). |
| `assets/css/style.css` | All styling. Colours come from the custom properties in `:root` / `[data-theme="dark"]`, so change them there, not in the rules. Layout widths: `.wrap` (1120 px) and `.wrap.narrow` (720 px, for reading pages). |
| `assets/js/` | `theme-toggle.js` (light/dark; follows the system until you choose), `gallery.js` (lightbox with ← → keys, loaded only on the gallery page). |
| `tag/*.md` | One stub per tag, each with `tag:` and `permalink:`. New tag → new stub. (A Liquid-variable permalink such as `/tag/{{ page.tag }}/` doesn't work in Jekyll; it publishes that literal path.) |
| `tennis/` | **Generated.** The UQ Tennis Club season dashboards; see below. |
| `/matchcentre-dashboard/`, `/translink-gocard-dashboard/` | Not in this repo: each is its own repo's GitHub Pages site, served under this domain automatically. |

Dark mode is set before first paint by an inline script in `_includes/head.html`, then
toggled by `assets/js/theme-toggle.js`, which stores the choice in `localStorage`.

## The tennis dashboard (`tennis/`)

`tennis/` is **build output — do not hand-edit it.** It comes from the
`tennis-scorecard-generator` project, which reads the club's PDF scorecards on an
airgapped machine. To publish a new round:

```bash
# on the airgapped machine, in tennis-scorecard-generator/
python3 tools/ingest.py                       # re-read the scorecards
python3 tools/build_site.py \
    --out /path/to/bwenstar.github.io/tennis \
    --mode subdir --home-url / --home-label "brendanta.com"
```

Then commit the changed files under `tennis/` and push.

`--mode subdir` matters: the other mode (`standalone`) writes a `.nojekyll` file and
its own `404.html`, and a `.nojekyll` anywhere in this repo would switch Jekyll off
and break every page. The five files it does write contain no front matter and no
`{{` or `{%`, so Jekyll copies them verbatim.

## Notes

- `robots.txt` blocks all crawlers, on purpose — the dashboard lists real player
  names. The pages are still public to anyone with the link.
- `exclude:` in `_config.yml` **replaces** Jekyll's default exclude list, so build
  files like `Gemfile` have to be listed there explicitly.
- `fifo-iio/` and `img/` predate the `assets/` layout and are served as-is.
