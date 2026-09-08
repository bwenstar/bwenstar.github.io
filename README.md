# bwenstar.github.io

Personal site for [Brendan Ta](https://github.com/bwenstar), served by GitHub Pages
at <https://brendanta.com> (see `CNAME`). Jekyll, no theme gem — the layouts and CSS
in this repo are the whole design.

## Running it locally

```bash
bundle install
bundle exec jekyll serve      # http://127.0.0.1:4000
```

`Gemfile` pins plain `jekyll` (not the `github-pages` gem) because nothing here uses
a plugin. `bundle exec jekyll build` writes `_site/`, which is what CI publishes.

## Layout

| Path | What it is |
|------|------------|
| `_config.yml` | Site settings. `projects:` drives the Projects cards on the home page — add an entry there rather than editing `index.html`. |
| `_layouts/` | `default` (shell), `post`, `tag_posts`. |
| `_includes/` | `head`, `header`, `footer`, `tag-cloud`, `gallery-content`. |
| `_posts/` | Blog posts, `YYYY-MM-DD-slug.md`. |
| `_data/gallery.yml` | Gallery image list (filename, title, tags). |
| `assets/css/style.css` | All styling. Colours come from the custom properties in `:root` / `[data-theme="dark"]` — change them there, not in the rules. |
| `assets/js/` | `theme-toggle.js` (light/dark), `gallery.js` (lightbox). |
| `tag/*.md` | One stub per tag, each with `tag:` and `permalink:`. New tag → new stub. |
| `tennis/` | **Generated.** The Division C dashboard; see below. |

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
