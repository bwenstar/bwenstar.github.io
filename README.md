# bwenstar.github.io

Personal site for [Brendan Ta](https://github.com/bwenstar), live at <https://brendanta.com>.
It's plain Jekyll with no theme: the layouts and CSS in this repo are the whole design.

- [Publishing a change](#publishing-a-change)
- [Previewing before you push](#previewing-before-you-push)
- [How do I…](#how-do-i)
  - [add, edit or remove a project card](#add-edit-or-remove-a-project-card)
  - [make a project card image](#make-a-project-card-image)
  - [change the intro or About text](#change-the-intro-or-about-text)
  - [write a post](#write-a-post)
  - [add photos to the gallery](#add-photos-to-the-gallery)
  - [publish a new tennis round](#publish-a-new-tennis-round)
  - [change colours, fonts or the menu](#change-colours-fonts-or-the-menu)
- [If something breaks](#if-something-breaks)
- [Don'ts](#donts)
- [Where everything is](#where-everything-is)

---

## Publishing a change

GitHub builds and publishes the site automatically from the `master` branch.

```bash
git add -A
git commit -m "Describe the change"
git push
```

It's live about a minute later. To watch it, open the repo's **Actions** tab and find
**"pages build and deployment"**: a green tick means it's published.

GitHub uses its own built-in Jekyll (version 3.10) with no plugins. Anything in this
repo has to work with that; see [Don'ts](#donts).

## Previewing before you push

**With Docker** (no Ruby needed; same Jekyll version as GitHub):

```bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e JEKYLL_NO_BUNDLER_REQUIRE=true \
  -v "$PWD:/srv/jekyll:ro" -v "$PWD/_site:/out" -w /tmp \
  jekyll/jekyll:pages jekyll build --source /srv/jekyll --destination /out --safe
python3 -m http.server -d _site 4000      # open http://127.0.0.1:4000
```

Re-run the `docker run` line after each change (the first run downloads the image).

**With Ruby**: run `bundle install` once, then `bundle exec jekyll serve`, and open
<http://127.0.0.1:4000>. Pages rebuild as you save.

`_site/` is build output; don't commit it.

---

## How do I…

### add, edit or remove a project card

The cards on the home page, and the list on the About page, come from `projects:` in
**`_config.yml`**. You don't need to touch any HTML. Each card looks like this:

```yaml
projects:
  - name:   "go card travel dashboard"          # card title
    kicker: "Open source · Public transport"    # small label above the title
    blurb:  "One or two sentences about it."
    image:  "/assets/img/projects/gocard.webp"  # see "make a project card image"
    url:    "/translink-gocard-dashboard/"      # where the image and title link to
    tags:   [Python, GTFS, Leaflet]             # small grey chips
    links:                                      # buttons; the first one is blue
      - label: "Live demo"
        url:   "/translink-gocard-dashboard/"
      - label: "Code"
        url:   "https://github.com/bwenstar/translink-gocard-dashboard"
```

- **Add a card:** copy a block, change it, and keep the two-space indents.
- **Reorder:** move the blocks. Cards appear in the same order.
- **Remove:** delete the block.
- **Links:** a `url` starting with `/` is on this site. Anything starting with `https://` is
  external and gets a ↗ arrow.
- **Another repo's demo:** if that repo has GitHub Pages switched on (Settings → Pages), it's
  automatically served at `https://brendanta.com/<repo-name>/`, and that's the URL to use.
  The tennis tool and go card demos work this way. They live in their own repos, not this one.

`_config.yml` changes don't hot-reload with `jekyll serve`, so restart it after editing.

### make a project card image

Cards expect a **16:10 image, 960×600, in WebP**, saved in `assets/img/projects/`.

1. Open the page at 1280 px wide and take a screenshot. The top 1280×800 of the page
   is the part that matters.
2. Crop it to 16:10 and save it as WebP. With Python and Pillow:

   ```bash
   python3 -c "
   from PIL import Image
   im = Image.open('screenshot.png').convert('RGB')
   im = im.crop((0, 0, 1280, 800))               # left, top, right, bottom: pick a 16:10 box
   im.resize((960, 600)).save('assets/img/projects/NAME.webp', quality=82)
   "
   ```

   Or use any image editor: crop to 1280×800, resize to 960×600 and export as WebP. Aim for
   under ~60 KB.

**Check the image for real people's names before you commit it.** The tennis dashboards
list players. The current images show only the competition list, the demo club's team
ladder and the go card dashboard's fictional data.

### change the intro or About text

| Text | File |
|---|---|
| Big headline, paragraph and buttons at the top of the home page | `index.html`, the section with `class="hero wrap"` |
| Name in the header and the browser tab | `title:` in `_config.yml` |
| Description shown when the site is shared (search, social previews) | `description:` in `_config.yml` |
| About page | `about.html`. The "What's here" list fills itself from `projects:`. |
| Your photo on the About page | `avatar:` in `_config.yml` (currently `assets/img/borko.png`) |
| Browser tab icon | the `<link rel="icon">` line in `_includes/head.html` |

### write a post

Create `_posts/YYYY-MM-DD-short-title.md`, for example `_posts/2026-11-02-new-racquet.md`:

```markdown
---
layout: post
title:  "New racquet"
date:   2026-11-02 19:00:00 +1000
excerpt: "One line shown on the home page."
tags:   [tennis]
---

Write in **Markdown**. Images: put them in `assets/img/` and use
![description](/assets/img/your-photo.jpg)
```

The six newest posts appear under **Notes** on the home page.

**Using a tag for the first time?** Also create `tag/<tag>.md`, otherwise its tag link
leads to a 404. Copy an existing one and change two lines:

```markdown
---
layout: tag_posts
title:  "Posts tagged: tennis"
tag:   tennis
permalink: /tag/tennis/
---
```

A post dated in the future won't appear until that date has passed and the site is rebuilt.

### add photos to the gallery

1. Put the image in `assets/img/gallery/`. Resize large camera files to ~2000 px on the long
   side first, so the page stays fast.
2. Add an entry to `_data/gallery.yml`:

   ```yaml
   - filename: assets/img/gallery/DSC05000.JPG
     title: "Club championships final"
     tags: [tennis, singles]
   ```

The first three entries also appear in the **Photos** strip on the home page, so put your
favourites first. Tags show as labels in the photo viewer.

### publish a new tennis round

`tennis/` is generated. **Don't edit files in it by hand.** It comes from the
`tennis-scorecard-generator` project, which reads the club's PDF scorecards on an
airgapped machine:

```bash
# on the airgapped machine, in tennis-scorecard-generator/
python3 tools/ingest.py                       # re-read the scorecards
python3 tools/build_site.py \
    --out /path/to/bwenstar.github.io/tennis \
    --mode subdir --home-url / --home-label "brendanta.com"
```

Then commit the changed files under `tennis/` and push, as usual.

Always use `--mode subdir`. The other mode (`standalone`) writes a `.nojekyll` file and its
own `404.html`, and a `.nojekyll` anywhere in this repo switches Jekyll off and breaks
every page. The files `subdir` writes contain no Jekyll syntax, so they're copied as they are.

The tennis pages have their own styling. The redesign of the rest of the site doesn't
change them.

### change colours, fonts or the menu

- **Colours:** all in `assets/css/style.css`, at the top. `:root` is light mode and
  `[data-theme="dark"]` is dark mode. Change the variables (`--accent`, `--bg`, …) there, not
  in individual rules, and both modes stay consistent.
- **Font:** Inter, loaded in `_includes/head.html`. To switch, change that `<link>` and
  `--font` in the CSS.
- **Menu links:** `_includes/header.html`. The footer links are separate, in
  `_includes/footer.html`, so update both.
- **Page widths:** `--wide` (1120 px, home and gallery) and `--narrow` (720 px, reading
  pages) in the CSS.

---

## If something breaks

- **The Actions run has a red ✗:** open it, then open the failed step. The error names the
  file and line. Common causes:
  - YAML indentation in `_config.yml` or `_data/gallery.yml`. Use spaces, not tabs, and line
    up the dashes.
  - A post missing its `---` front matter block.
  - Unclosed Liquid tags (`{% if %}` without `{% endif %}`).
- **Push worked but nothing changed:** wait a minute, then hard-refresh (Ctrl+Shift+R). Check
  that the Actions run finished.
- **A page shows raw `{{ ... }}`:** Liquid only runs in files that start with front matter
  (`---` lines).
- **Every page is unstyled or 404s:** look for a `.nojekyll` file (see below) and delete it.
- **To undo a change:** `git revert <commit>` then `git push`. The previous version comes
  back within a minute.

## Don'ts

- **Don't add a `.nojekyll` file** anywhere. It switches Jekyll off for the whole site.
- **Don't hand-edit `tennis/`.** Regenerate it (see above).
- **Don't use Jekyll plugins or Liquid in `permalink:`.** GitHub's builder ignores plugins, and
  `permalink: /tag/{{ page.tag }}/` publishes that literal text as the URL.
- **Leave "Custom domain" blank on your other repos' Pages settings** (tennis tool,
  go card). They're served at `brendanta.com/<repo>/` because this repo's `CNAME` is
  brendanta.com. Setting a domain there moves that project off brendanta.com.
- **Don't remove `robots.txt`** unless you want the tennis pages, with real player names,
  in search results. It keeps search engines out, though anyone with a link can still visit.
- **Don't edit `exclude:` in `_config.yml` casually.** It *replaces* Jekyll's default list,
  so build files like `Gemfile` must stay listed there or they get published.

## Where everything is

| Path | What it is |
|---|---|
| `_config.yml` | Site title, description, author, and the `projects:` cards |
| `index.html` | Home page: intro, project cards, notes, photos |
| `about.html`, `gallery.html`, `404.html` | Those pages |
| `_posts/` | Blog posts (`YYYY-MM-DD-slug.md`) |
| `tag/*.md` | One small file per tag |
| `_data/gallery.yml` | Gallery photo list |
| `_layouts/` | Page shells: `default` (every page), `post`, `tag_posts` |
| `_includes/` | Shared pieces: `head` (fonts, dark-mode script), `header` (menu), `footer`, `tag-cloud`, `gallery-content` |
| `assets/css/style.css` | All styling (colours at the top) |
| `assets/js/theme-toggle.js` | Light/dark switch. It follows the system setting until you choose. |
| `assets/js/gallery.js` | Photo viewer (← → keys, Esc to close). Only loaded on the gallery page. |
| `assets/img/projects/` | Project card images (960×600 WebP) |
| `assets/img/gallery/` | Gallery photos |
| `tennis/` | **Generated** UQ Tennis Club season dashboards |
| `CNAME` | The custom domain, `brendanta.com`. Don't change it. |
| `robots.txt` | Keeps search engines out (see Don'ts) |
| `fifo-iio/`, `img/` | Older files, served as they are |
| `Gemfile` | Only for previewing with Ruby. GitHub doesn't use it. |
| `.github/workflows/deploy.yml` | **Not used:** it's set to run on a `main` branch and this repo uses `master`. GitHub publishes straight from `master` instead. Safe to delete. |
