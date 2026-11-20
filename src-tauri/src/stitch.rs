// Scrolling capture: the logic that decides how far a view has scrolled and glues the views
// together. It is pure (no screen, no mouse) so it can be tested on any machine. The Windows
// side only has to implement `ScrollIo`.
//
// How it works, in short:
//  * Every captured view is reduced to one small "descriptor" per pixel row (32 average
//    brightness values across the width). Comparing descriptors is far cheaper than pixels and
//    shrugs off tiny differences such as a blinking caret.
//  * Rows that do not move between two views (sticky header or footer) are detected once and
//    kept out of the matching; the header is used once at the top and the footer once at the end.
//  * The scroll distance between two views is the shift with the smallest average difference.
//    An absolute scroll position is tracked, so scrolling back and forth never duplicates content.

const BUCKETS: usize = 32;
/// Row difference (sum over buckets) still counted as "the same row".
const ROW_TOL: u32 = 48;
/// A row needs some detail to count as evidence (blank rows match everything).
const INFORMATIVE: u8 = 4;
/// Largest number of wheel notches sent in one step.
const MAX_NOTCHES: i32 = 40;
/// Two shifts whose average row difference is this close count as equally good.
const TIE: f64 = 0.25;

#[derive(Clone)]
pub struct Img {
    pub w: usize,
    pub h: usize,
    pub rgba: Vec<u8>,
}

impl Img {
    pub fn new(w: usize, h: usize, rgba: Vec<u8>) -> Img {
        debug_assert_eq!(rgba.len(), w * h * 4);
        Img { w, h, rgba }
    }
    fn rows(&self, a: usize, b: usize) -> &[u8] {
        &self.rgba[a * self.w * 4..b * self.w * 4]
    }
}

struct Desc {
    /// h * BUCKETS brightness averages
    d: Vec<u8>,
    /// per row: has enough detail to be evidence
    info: Vec<bool>,
}

fn describe(img: &Img) -> Desc {
    let (w, h) = (img.w, img.h);
    let mut d = vec![0u8; h * BUCKETS];
    let mut info = vec![false; h];
    for y in 0..h {
        let row = &img.rgba[y * w * 4..(y + 1) * w * 4];
        let (mut mn, mut mx) = (255u8, 0u8);
        for b in 0..BUCKETS {
            let x0 = b * w / BUCKETS;
            let x1 = ((b + 1) * w / BUCKETS).max(x0 + 1).min(w);
            let mut sum = 0u32;
            for x in x0..x1 {
                let p = &row[x * 4..x * 4 + 3];
                sum += (p[0] as u32 * 30 + p[1] as u32 * 59 + p[2] as u32 * 11) / 100;
            }
            let v = (sum / (x1 - x0) as u32) as u8;
            d[y * BUCKETS + b] = v;
            mn = mn.min(v);
            mx = mx.max(v);
        }
        info[y] = mx - mn >= INFORMATIVE;
    }
    Desc { d, info }
}

#[inline]
fn row_dist(a: &Desc, ai: usize, b: &Desc, bi: usize) -> u32 {
    let x = &a.d[ai * BUCKETS..(ai + 1) * BUCKETS];
    let y = &b.d[bi * BUCKETS..(bi + 1) * BUCKETS];
    let mut s = 0u32;
    for i in 0..BUCKETS {
        s += (x[i] as i32 - y[i] as i32).unsigned_abs();
    }
    s
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Push {
    /// The view did not move.
    NoChange,
    /// Scrolled by this many pixels (positive = further down).
    Moved(i32),
    /// Could not work out how far it moved.
    Lost,
}

pub struct Stitcher {
    w: usize,
    h: usize,
    top: usize,
    bot: usize,
    ready: bool,
    prev: Img,
    prev_desc: Desc,
    /// Everything above the footer, row after row.
    out: Vec<u8>,
    /// Scroll position of the current view (content coordinates).
    pos: i64,
    /// How many rows of scrolling content are in `out`.
    covered: i64,
}

impl Stitcher {
    pub fn new(first: Img) -> Stitcher {
        let prev_desc = describe(&first);
        Stitcher {
            w: first.w,
            h: first.h,
            top: 0,
            bot: 0,
            ready: false,
            prev: first,
            prev_desc,
            out: Vec::new(),
            pos: 0,
            covered: 0,
        }
    }

    /// Height of the image so far (header + content + footer).
    pub fn height(&self) -> usize {
        if !self.ready {
            return self.h;
        }
        self.top + self.covered as usize + self.bot
    }

    fn scroll_len(&self) -> usize {
        self.h - self.top - self.bot
    }

    /// Finds the static header/footer from the first pair of views that differ.
    fn learn_static(&mut self, cur: &Img, cd: &Desc) -> bool {
        let h = self.h;
        let same = |i: usize| row_dist(&self.prev_desc, i, cd, i) <= 8;
        let mut lead = 0;
        while lead < h && same(lead) {
            lead += 1;
        }
        if lead == h {
            return false; // identical views
        }
        let mut trail = 0;
        while trail < h - lead && same(h - 1 - trail) {
            trail += 1;
        }
        // Blank stretches look "static" but are just empty page: only keep the part
        // of the run that has detail in it.
        let mut top = lead;
        while top > 0 && !self.prev_desc.info[top - 1] {
            top -= 1;
        }
        let mut bot = trail;
        while bot > 0 && !self.prev_desc.info[h - bot] {
            bot -= 1;
        }
        let min_scroll = (h / 5).max(48);
        if h < top + bot + min_scroll {
            top = 0;
            bot = 0;
        }
        self.top = top;
        self.bot = bot;
        self.ready = true;
        let l = self.scroll_len();
        self.out = self.prev.rows(0, top + l).to_vec();
        self.pos = 0;
        self.covered = l as i64;
        let _ = cur;
        true
    }

    /// Shift s such that current row i equals previous row i+s, over the scrolling rows.
    fn find_shift(&self, cd: &Desc, hint: Option<i32>) -> Option<i32> {
        let l = self.scroll_len() as i32;
        let t = self.top;
        let min_overlap = (l / 6).max(24);
        let max_s = l - min_overlap;
        if max_s < 1 {
            return None;
        }
        let min_info = ((l as usize) / 25).max(6);
        // (mean difference, shift) of every shift that fits
        let mut found: Vec<(f64, i32)> = Vec::new();
        let mut best_mean = f64::MAX;
        for s in -max_s..=max_s {
            if s == 0 {
                continue;
            }
            // compared current rows i in [i0, i1)
            let (i0, i1) = if s > 0 { (0, l - s) } else { (-s, l) };
            let n = (i1 - i0) as usize;
            let budget = if best_mean == f64::MAX { f64::MAX } else { (best_mean + TIE) * n as f64 };
            let mut sum = 0f64;
            let (mut info_rows, mut info_ok) = (0usize, 0usize);
            let mut aborted = false;
            for i in i0..i1 {
                let a = t + i as usize;
                let b = t + (i + s) as usize;
                let d = row_dist(cd, a, &self.prev_desc, b);
                sum += d as f64;
                if cd.info[a] || self.prev_desc.info[b] {
                    info_rows += 1;
                    if d <= ROW_TOL {
                        info_ok += 1;
                    }
                }
                if sum > budget {
                    aborted = true;
                    break;
                }
            }
            if aborted || info_rows < min_info || (info_ok as f64) < 0.9 * info_rows as f64 {
                continue;
            }
            let mean = sum / n as f64;
            best_mean = best_mean.min(mean);
            found.push((mean, s));
        }
        // Repeating content (identical list items) can fit several shifts equally well:
        // among the near-equal ones take the shift we expected, else the smallest downward one.
        found
            .into_iter()
            .filter(|(m, _)| *m <= best_mean + TIE)
            .min_by_key(|(_, s)| match hint {
                Some(h) => ((*s - h).abs(), 0),
                None => (s.abs(), (*s < 0) as i32),
            })
            .map(|(_, s)| s)
    }

    /// True when the scrolling rows of both views are the same.
    fn unchanged(&self, cd: &Desc) -> bool {
        let l = self.scroll_len();
        let mut bad = 0;
        let mut info = 0;
        for i in 0..l {
            let a = self.top + i;
            if cd.info[a] || self.prev_desc.info[a] {
                info += 1;
            }
            if row_dist(cd, a, &self.prev_desc, a) > ROW_TOL {
                bad += 1;
            }
        }
        let allow = (l / 50).max(1);
        let _ = info;
        bad <= allow
    }

    /// Feeds the next captured view.
    pub fn push(&mut self, cur: Img, hint: Option<i32>) -> Push {
        if cur.w != self.w || cur.h != self.h {
            return Push::Lost;
        }
        let cd = describe(&cur);
        if !self.ready {
            if !self.learn_static(&cur, &cd) {
                return Push::NoChange;
            }
        } else if self.unchanged(&cd) {
            // keep the newest pixels as the reference
            self.prev = cur;
            self.prev_desc = cd;
            return Push::NoChange;
        }
        let Some(s) = self.find_shift(&cd, hint) else {
            return Push::Lost;
        };
        self.pos += s as i64;
        let l = self.scroll_len() as i64;
        let need = self.pos + l - self.covered;
        if need > 0 {
            let need = need as usize;
            let rows = self.scroll_len();
            let from = self.top + rows - need;
            let strip = cur.rows(from, self.top + rows).to_vec();
            self.out.extend_from_slice(&strip);
            self.covered += need as i64;
        }
        self.prev = cur;
        self.prev_desc = cd;
        Push::Moved(s)
    }

    /// The finished picture: header, everything scrolled through, footer.
    pub fn finish(self) -> Img {
        if !self.ready {
            return self.prev;
        }
        let mut out = self.out;
        out.extend_from_slice(self.prev.rows(self.h - self.bot, self.h));
        let h = out.len() / (self.w * 4);
        Img { w: self.w, h, rgba: out }
    }
}

// ---------------------------------------------------------------------------
// The capture loop
// ---------------------------------------------------------------------------

pub trait ScrollIo {
    /// A view of the region once it has stopped moving.
    fn grab(&mut self) -> Result<Img, String>;
    /// Positive = scroll down, negative = scroll up, in wheel notches.
    fn wheel(&mut self, notches: i32);
    fn stopped(&self) -> bool;
    fn progress(&mut self, height: usize);
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Stop {
    EndReached,
    UserStopped,
    SizeLimit,
    /// Nothing moved at all.
    NoScroll,
    /// Lost track of how far it scrolled; what was gathered so far is returned.
    LostTrack,
}

pub fn run<IO: ScrollIo>(io: &mut IO, max_pixels: usize) -> Result<(Img, Stop), String> {
    let first = io.grab()?;
    let (w, h) = (first.w, first.h);
    let mut st = Stitcher::new(first);
    let mut notches: i32 = 1;
    let mut per_notch: Option<f64> = None;
    let mut idle = 0;
    let mut fails = 0;
    let mut moved = false;
    let reason;
    loop {
        if io.stopped() {
            reason = Stop::UserStopped;
            break;
        }
        if st.height() * w >= max_pixels {
            reason = Stop::SizeLimit;
            break;
        }
        io.wheel(notches);
        let cur = io.grab()?;
        let hint = per_notch.map(|p| (p * notches as f64).round() as i32);
        match st.push(cur, hint) {
            Push::NoChange => {
                idle += 1;
                if idle >= 2 {
                    reason = if moved { Stop::EndReached } else { Stop::NoScroll };
                    break;
                }
                notches = (notches * 2).min(MAX_NOTCHES);
            }
            Push::Moved(s) => {
                idle = 0;
                fails = 0;
                moved = true;
                io.progress(st.height());
                if s > 0 {
                    let pn = s as f64 / notches as f64;
                    per_notch = Some(pn);
                    let target = st.scroll_len() as f64 * 0.6;
                    let next = (target / pn).round() as i32;
                    notches = next.clamp(1, (notches * 3).min(MAX_NOTCHES));
                }
            }
            Push::Lost => {
                fails += 1;
                if fails > 3 {
                    reason = Stop::LostTrack;
                    break;
                }
                // Go back to where we were, then take smaller steps.
                io.wheel(-notches);
                let back = io.grab()?;
                let back_hint = per_notch.map(|p| -(p * notches as f64).round() as i32);
                if st.push(back, back_hint) == Push::Lost {
                    reason = Stop::LostTrack;
                    break;
                }
                notches = (notches / 2).max(1);
            }
        }
    }
    let _ = h;
    Ok((st.finish(), reason))
}

// ---------------------------------------------------------------------------
// Hand scrolling: the user turns the mouse wheel, we watch the area and stitch what we see
// ---------------------------------------------------------------------------

pub trait ManualIo {
    /// The area right now (no waiting).
    fn snap(&mut self) -> Result<Img, String>;
    /// Short pause between looks.
    fn pause(&mut self);
    fn stopped(&self) -> bool;
    fn progress(&mut self, height: usize);
    /// True while the user has scrolled too far or too fast to follow; false again once back on track.
    fn lost(&mut self, lost: bool);
}

pub fn run_manual<IO: ManualIo>(io: &mut IO, max_pixels: usize) -> Result<(Img, Stop), String> {
    let first = io.snap()?;
    let w = first.w;
    let mut last_seen = first.rgba.clone();
    let mut st = Stitcher::new(first);
    let mut moved = false;
    let mut lost = false;
    let mut last_move: i32 = 0;
    let reason;
    loop {
        if io.stopped() {
            reason = if moved { Stop::UserStopped } else { Stop::NoScroll };
            break;
        }
        if st.height() * w >= max_pixels {
            reason = Stop::SizeLimit;
            break;
        }
        io.pause();
        let cur = io.snap()?;
        if cur.rgba == last_seen {
            continue;
        }
        last_seen.clear();
        last_seen.extend_from_slice(&cur.rgba);
        let hint = if last_move != 0 { Some(last_move) } else { None };
        match st.push(cur, hint) {
            Push::Moved(s) => {
                moved = true;
                last_move = s;
                if lost {
                    lost = false;
                    io.lost(false);
                }
                io.progress(st.height());
            }
            Push::NoChange => {
                if lost {
                    lost = false;
                    io.lost(false);
                }
            }
            Push::Lost => {
                if !lost {
                    lost = true;
                    io.lost(true);
                }
            }
        }
    }
    Ok((st.finish(), reason))
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 240;
    const VIEW_H: usize = 360;
    const HEAD: usize = 40;
    const FOOT: usize = 30;

    fn hash(a: u64, b: u64) -> u64 {
        let mut x = a.wrapping_mul(0x9E3779B97F4A7C15) ^ b.wrapping_mul(0xC2B2AE3D27D4EB4F);
        x ^= x >> 29;
        x = x.wrapping_mul(0xBF58476D1CE4E5B9);
        x ^= x >> 32;
        x
    }

    /// Text-like content: lines of blocks, with some variation from row to row.
    fn content_row(r: usize, out: &mut [u8]) {
        let line = (r / 14) as u64;
        let within = (r % 14) as u64;
        for x in 0..W {
            let block = hash(line, (x / 5) as u64);
            let ink = block % 3 != 0 && within >= 2 && within < 11;
            let jitter = (hash(r as u64, x as u64) % 9) as u8;
            let v = if ink { 20 + jitter } else { 235 + jitter / 2 };
            out[x * 4..x * 4 + 4].copy_from_slice(&[v, v, v, 255]);
        }
    }

    fn static_row(tag: u8, y: usize, out: &mut [u8]) {
        for x in 0..W {
            let v = if (x / 7 + y / 3) % 2 == 0 { 60 + tag } else { 200 };
            out[x * 4..x * 4 + 4].copy_from_slice(&[v, v / 2, 90, 255]);
        }
    }

    struct Page {
        content: Vec<u8>, // rows * W * 4
        rows: usize,
        pos: f64,
        target: f64,
        per_notch: f64,
        lag: bool,
        header: bool,
        footer: bool,
        wheel_works: bool,
        stop_after_grabs: Option<usize>,
        grabs: usize,
        notch_log: Vec<i32>,
    }

    impl Page {
        fn new(rows: usize, per_notch: f64) -> Page {
            let mut content = vec![0u8; rows * W * 4];
            for r in 0..rows {
                content_row(r, &mut content[r * W * 4..(r + 1) * W * 4]);
            }
            Page {
                content,
                rows,
                pos: 0.0,
                target: 0.0,
                per_notch,
                lag: true,
                header: true,
                footer: true,
                wheel_works: true,
                stop_after_grabs: None,
                grabs: 0,
                notch_log: vec![],
            }
        }
        fn scroll_len(&self) -> usize {
            VIEW_H - if self.header { HEAD } else { 0 } - if self.footer { FOOT } else { 0 }
        }
        fn max_pos(&self) -> f64 {
            (self.rows - self.scroll_len()) as f64
        }
        fn render(&self, pos: usize) -> Img {
            let mut px = vec![0u8; VIEW_H * W * 4];
            let (h0, f0) = (if self.header { HEAD } else { 0 }, if self.footer { FOOT } else { 0 });
            for y in 0..VIEW_H {
                let row = &mut px[y * W * 4..(y + 1) * W * 4];
                if y < h0 {
                    static_row(1, y, row);
                } else if y >= VIEW_H - f0 {
                    static_row(2, y, row);
                } else {
                    let r = pos + (y - h0);
                    row.copy_from_slice(&self.content[r * W * 4..(r + 1) * W * 4]);
                }
            }
            Img::new(W, VIEW_H, px)
        }
        /// What the correct final picture is, from `start` to the end of the page.
        fn expected(&self, start: usize) -> Img {
            let mut px = Vec::new();
            let (h0, f0) = (if self.header { HEAD } else { 0 }, if self.footer { FOOT } else { 0 });
            for y in 0..h0 {
                let mut row = vec![0u8; W * 4];
                static_row(1, y, &mut row);
                px.extend(row);
            }
            px.extend_from_slice(&self.content[start * W * 4..self.rows * W * 4]);
            for y in VIEW_H - f0..VIEW_H {
                let mut row = vec![0u8; W * 4];
                static_row(2, y, &mut row);
                px.extend(row);
            }
            let h = px.len() / (W * 4);
            Img::new(W, h, px)
        }
    }

    impl ScrollIo for Page {
        fn grab(&mut self) -> Result<Img, String> {
            self.grabs += 1;
            self.pos = self.target;
            Ok(self.render(self.pos.round() as usize))
        }
        fn wheel(&mut self, notches: i32) {
            self.notch_log.push(notches);
            if !self.wheel_works {
                return;
            }
            let _ = self.lag;
            self.target = (self.target + notches as f64 * self.per_notch).clamp(0.0, self.max_pos());
        }
        fn stopped(&self) -> bool {
            self.stop_after_grabs.map_or(false, |n| self.grabs >= n)
        }
        fn progress(&mut self, _h: usize) {}
    }

    fn same(a: &Img, b: &Img) -> bool {
        a.w == b.w && a.h == b.h && a.rgba == b.rgba
    }

    #[test]
    fn whole_page_with_sticky_header_and_footer() {
        let mut p = Page::new(3000, 57.0);
        let (img, why) = run(&mut p, usize::MAX).unwrap();
        assert_eq!(why, Stop::EndReached);
        let exp = p.expected(0);
        assert_eq!((img.w, img.h), (exp.w, exp.h));
        assert!(same(&img, &exp), "stitched image differs from the page");
    }

    #[test]
    fn plain_page_without_static_parts() {
        let mut p = Page::new(2500, 100.0);
        p.header = false;
        p.footer = false;
        let (img, why) = run(&mut p, usize::MAX).unwrap();
        assert_eq!(why, Stop::EndReached);
        assert!(same(&img, &p.expected(0)));
    }

    #[test]
    fn starts_from_the_middle() {
        let mut p = Page::new(2400, 48.0);
        p.target = 700.0;
        let (img, _) = run(&mut p, usize::MAX).unwrap();
        assert!(same(&img, &p.expected(700)));
    }

    #[test]
    fn short_page_that_barely_scrolls() {
        let mut p = Page::new(420, 40.0);
        let (img, why) = run(&mut p, usize::MAX).unwrap();
        assert_eq!(why, Stop::EndReached);
        assert!(same(&img, &p.expected(0)));
    }

    #[test]
    fn step_larger_than_the_view_is_reported_not_garbled() {
        let mut p = Page::new(3000, 500.0);
        let (img, why) = run(&mut p, usize::MAX).unwrap();
        assert_eq!(why, Stop::LostTrack);
        // only the first view was gathered, and it is intact
        assert_eq!(img.h, VIEW_H);
        assert!(same(&img, &p.render(0)));
    }

    #[test]
    fn nothing_scrolls() {
        let mut p = Page::new(3000, 50.0);
        p.wheel_works = false;
        let (_, why) = run(&mut p, usize::MAX).unwrap();
        assert_eq!(why, Stop::NoScroll);
    }

    #[test]
    fn user_can_stop_and_keep_the_part_gathered() {
        let mut p = Page::new(5000, 57.0);
        p.stop_after_grabs = Some(8);
        let (img, why) = run(&mut p, usize::MAX).unwrap();
        assert_eq!(why, Stop::UserStopped);
        assert!(img.h > VIEW_H * 2 && img.h < p.rows);
        // everything gathered is a true prefix of the page
        let exp = p.expected(0);
        let body_rows = img.h - HEAD - FOOT;
        assert_eq!(&img.rgba[..(HEAD + body_rows) * W * 4], &exp.rgba[..(HEAD + body_rows) * W * 4]);
    }

    #[test]
    fn size_limit_stops_early() {
        let mut p = Page::new(8000, 57.0);
        let (img, why) = run(&mut p, W * 1500).unwrap();
        assert_eq!(why, Stop::SizeLimit);
        assert!(img.h >= 1500 && img.h < 2200, "{}", img.h);
    }

    #[test]
    fn calibrates_to_big_steps() {
        let mut p = Page::new(6000, 30.0);
        let (img, _) = run(&mut p, usize::MAX).unwrap();
        assert!(same(&img, &p.expected(0)));
        let max = *p.notch_log.iter().max().unwrap();
        assert!(max >= 5, "should have learned to send bigger steps, max was {max}");
    }

    #[test]
    fn scrolling_back_does_not_duplicate_content() {
        // feed views by hand: down, down, up, down further
        let p = Page::new(2000, 1.0);
        let mut st = Stitcher::new(p.render(0));
        for pos in [90usize, 180, 120, 260, 350] {
            let r = st.push(p.render(pos), None);
            assert!(matches!(r, Push::Moved(_)), "pos {pos}: {r:?}");
        }
        let img = st.finish();
        let exp_rows = HEAD + (350 + p.scroll_len()) + FOOT;
        assert_eq!(img.h, exp_rows);
        let mut e = Vec::new();
        for y in 0..HEAD {
            let mut row = vec![0u8; W * 4];
            static_row(1, y, &mut row);
            e.extend(row);
        }
        e.extend_from_slice(&p.content[..(350 + p.scroll_len()) * W * 4]);
        for y in VIEW_H - FOOT..VIEW_H {
            let mut row = vec![0u8; W * 4];
            static_row(2, y, &mut row);
            e.extend(row);
        }
        assert!(img.rgba == e);
    }

    #[test]
    fn blank_stretch_is_not_mistaken_for_a_header() {
        // a page that starts with 100 empty rows, then content
        let mut p = Page::new(2000, 60.0);
        p.header = false;
        p.footer = false;
        for r in 0..100 {
            for x in 0..W {
                p.content[(r * W + x) * 4..(r * W + x) * 4 + 4].copy_from_slice(&[255, 255, 255, 255]);
            }
        }
        let (img, why) = run(&mut p, usize::MAX).unwrap();
        assert_eq!(why, Stop::EndReached);
        assert!(same(&img, &p.expected(0)));
    }

    #[test]
    fn small_noise_does_not_break_matching() {
        let mut p = Page::new(1500, 50.0);
        let mut st = Stitcher::new(p.render(0));
        let mut v = p.render(60);
        // a blinking caret-like change in a few pixels
        for y in 100..112 {
            for x in 10..13 {
                v.rgba[(y * W + x) * 4] ^= 0x80;
            }
        }
        assert_eq!(st.push(v, None), Push::Moved(60));
        let _ = &mut p;
    }

    #[test]
    fn repeating_content_uses_the_expected_distance() {
        // every 60 rows the page repeats exactly for a long stretch (identical list items)
        let mut p = Page::new(2400, 45.0);
        p.header = false;
        p.footer = false;
        for r in 600..1800 {
            let src = 600 + (r - 600) % 60;
            let row: Vec<u8> = p.content[src * W * 4..(src + 1) * W * 4].to_vec();
            p.content[r * W * 4..(r + 1) * W * 4].copy_from_slice(&row);
        }
        let (img, why) = run(&mut p, usize::MAX).unwrap();
        assert_eq!(why, Stop::EndReached);
        assert!(same(&img, &p.expected(0)), "repeating section was stitched wrongly");
    }

    #[test]
    fn full_hd_view_is_fast_enough() {
        // 1900 x 1000 view; time one step of matching
        let w = 1900usize;
        let h = 1000usize;
        let mk = |pos: usize| {
            let mut px = vec![0u8; w * h * 4];
            for y in 0..h {
                let r = pos + y;
                for x in 0..w {
                    let ink = hash((r / 14) as u64, (x / 6) as u64) % 3 != 0 && (r % 14) >= 2 && (r % 14) < 11;
                    let v = if ink { 25 } else { 240 } + (hash(r as u64, x as u64) % 7) as u8;
                    px[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&[v, v, v, 255]);
                }
            }
            Img::new(w, h, px)
        };
        let a = mk(0);
        let b = mk(420);
        let mut st = Stitcher::new(a);
        let t = std::time::Instant::now();
        let r = st.push(b, None);
        let ms = t.elapsed().as_millis();
        eprintln!("full-HD step took {ms} ms");
        assert_eq!(r, Push::Moved(420));
    }

    struct Hand {
        page: Page,
        script: Vec<usize>, // scroll position at each look
        i: usize,
        lost_log: Vec<bool>,
    }
    impl ManualIo for Hand {
        fn snap(&mut self) -> Result<Img, String> {
            let pos = *self.script.get(self.i).unwrap_or(self.script.last().unwrap());
            self.i += 1;
            Ok(self.page.render(pos))
        }
        fn pause(&mut self) {}
        fn stopped(&self) -> bool {
            self.i > self.script.len() + 2
        }
        fn progress(&mut self, _h: usize) {}
        fn lost(&mut self, l: bool) {
            self.lost_log.push(l);
        }
    }

    fn hand(rows: usize, script: Vec<usize>) -> Hand {
        Hand { page: Page::new(rows, 1.0), script, i: 0, lost_log: vec![] }
    }

    #[test]
    fn hand_scrolling_smooth_and_continuous() {
        // many small steps, with pauses (repeated positions), down to the end
        let mut script = vec![0usize; 3];
        let mut p = 0usize;
        while p < 1710 {
            p = (p + 37).min(1710);
            script.push(p);
            if p % 5 == 0 {
                script.push(p);
            }
        }
        let mut h = hand(2000, script);
        let (img, why) = run_manual(&mut h, usize::MAX).unwrap();
        assert_eq!(why, Stop::UserStopped);
        assert!(same(&img, &h.page.expected(0)));
        assert!(h.lost_log.is_empty());
    }

    #[test]
    fn hand_scrolling_big_notches() {
        // 120 px per look, the way a wheel with fast repeats behaves
        let script: Vec<usize> = (0..=15).map(|k| (k * 120).min(1710)).collect();
        let mut h = hand(2000, script);
        let (img, _) = run_manual(&mut h, usize::MAX).unwrap();
        assert!(same(&img, &h.page.expected(0)));
    }

    #[test]
    fn hand_scrolling_too_fast_then_back_on_track() {
        // jumps 600 px (more than the view), is reported lost, then returns near and carries on
        let script = vec![0, 100, 700, 700, 190, 280, 400, 520, 640, 760, 880, 1000];
        let mut h = hand(2000, script);
        let (img, why) = run_manual(&mut h, usize::MAX).unwrap();
        assert_eq!(why, Stop::UserStopped);
        assert_eq!(h.lost_log, vec![true, false]);
        // everything up to the last view reached is intact, nothing duplicated
        let last = 1000 + h.page.scroll_len();
        let exp = h.page.expected(0);
        let want_rows = HEAD + last;
        assert_eq!(&img.rgba[..want_rows * W * 4], &exp.rgba[..want_rows * W * 4]);
        assert_eq!(img.h, HEAD + last + FOOT);
    }

    #[test]
    fn hand_scrolling_nothing_moves() {
        let mut h = hand(2000, vec![0, 0, 0]);
        let (img, why) = run_manual(&mut h, usize::MAX).unwrap();
        assert_eq!(why, Stop::NoScroll);
        assert!(same(&img, &h.page.render(0)));
    }

    #[test]
    fn hand_scrolling_up_and_down_adds_nothing_twice() {
        let script = vec![0, 80, 160, 240, 120, 40, 140, 260, 380, 500];
        let mut h = hand(2000, script);
        let (img, _) = run_manual(&mut h, usize::MAX).unwrap();
        assert_eq!(img.h, HEAD + 500 + h.page.scroll_len() + FOOT);
        let exp = h.page.expected(0);
        let rows = HEAD + 500 + h.page.scroll_len();
        assert_eq!(&img.rgba[..rows * W * 4], &exp.rgba[..rows * W * 4]);
    }
}
