'use strict';
const fs = require('fs'), path = require('path');
const U = require('./util');

function installSocialOps({ media, root, store }) {
  media.ops.tutorial_insert = {
    label: 'Silent tutorial overlay · original narration continues',
    params: { at: { type: 'number', min: 0, max: 7200, def: 10 }, excerptStart: { type: 'number', min: 0, max: 50, def: 0 },
      excerptSeconds: { type: 'number', min: 2, max: 12, def: 4 }, width: { type: 'number', min: 40, max: 80, def: 65 },
      height: { type: 'number', min: 30, max: 52, def: 40 } },
    async run({ project, params, ctx, file }) {
      const tutorial = path.join(root, 'assets/tutorials/surveoo.mp4');
      if (!fs.existsSync(tutorial)) throw Error('The saved Surveoo tutorial clip is missing.');
      const info = await media.probe(file), duration = Math.min(params.excerptSeconds, info.duration);
      const at = U.clamp(params.at, 0, Math.max(0, info.duration - duration));
      const W = info.width, H = info.height;
      const tw = Math.round(W * params.width / 100 / 2) * 2, th = Math.round(H * Math.min(params.height, 34) / 100 / 2) * 2;
      const filter = `[1:v]trim=duration=${duration},setpts=PTS-STARTPTS,scale=${tw}:${th}:force_original_aspect_ratio=decrease,setsar=1,format=rgba,fade=t=in:st=0:d=0.2:alpha=1,fade=t=out:st=${duration - .2}:d=0.2:alpha=1,setpts=PTS+${at}/TB[demo];[0:v][demo]overlay=x='(W-w)/2+30*max(0,1-(t-${at})/0.3)':y='H*0.47-h/2':enable='between(t,${at},${at + duration})':eof_action=pass[v]`;
      const out = media.nextFile(project.id, 'tutorial');
      ctx.progress('silent tutorial visual · one uninterrupted narrator', 60);
      await media.ff(['-i', file, '-ss', String(params.excerptStart), '-i', tutorial, '-filter_complex', filter,
        '-map', '[v]', '-map', '0:a:0', '-t', String(info.duration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
        '-c:a', 'copy', '-movflags', '+faststart', out], 900);
      return { file: out, params: { ...params, overlayAt: at, overlayDuration: duration, insertedAudio: false,
        sourceDuration: info.duration, tutorialFile: 'assets/tutorials/surveoo.mp4' }, kind: 'video' };
    }
  };

  media.ops.social_style = {
    label: 'Owner screenshot layout · audio-timed karaoke',
    params: { captions: { type: 'jsontext', max: 200000, required: true }, appearance: { type: 'jsontext', max: 10000, required: true },
      title: { type: 'string', literal: true, max: 120, def: '' }, price: { type: 'string', literal: true, max: 100, def: '' }, cta: { type: 'string', literal: true, max: 500, def: '' } },
    async run({ project, params, ctx, file }) {
      const info = await media.probe(file), style = JSON.parse(params.appearance), words = JSON.parse(params.captions), tracks = [];
      // This Windows Arial build renders the Arabic lam-alef as a missing glyph.
      if (style.font === 'Arial') style.font = 'Segoe UI';
      function track(name, lines, extra) {
        if (!lines.length) return;
        lines = lines.map(line => ({ ...line, text: line.text.replace(/\u2b07\ufe0f?/g, '↓') }));
        const ass = media.buildASS(lines, info, { style: { font: style.font, bold: false, weight: 'normal', color: '#ffffff', outline: 3,
          outlineColor: '#000000', shadow: 0, boxed: false, background: null, safeMarginX: 48, ...extra } });
        tracks.push({ name, style: ass.split('\n').find(l => l.startsWith('Style: ')).replace('Style: Def,', 'Style: ' + name + ','),
          events: ass.split('\n').filter(l => l.startsWith('Dialogue: ')).map(l => l.replace(',Def,,', ',' + name + ',,')), ass });
      }
      function wrap(text, max, maxLines = 2) {
        const explicit = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (explicit.length > 1) return explicit.join('\n');
        if (text.length <= max || maxLines === 1) return text;
        const tokens = text.split(/\s+/);
        const choices = tokens.slice(1).map((_, i) => [tokens.slice(0,i+1).join(' '),tokens.slice(i+1).join(' ')]);
        return choices.sort((a,b) => Math.abs(a[0].length-a[1].length)-Math.abs(b[0].length-b[1].length))[0]?.join('\n') || text;
      }
      const cap = style.karaoke ? words.map(w => ({ text: w.text, start: w.start, end: w.end, position: 'bottom',
        wordTimings: [w], style: { wordHighlight: true, activeWord: 0, phraseWords: [w.text] } })) : words;
      track('Caption', cap, { size: style.subtitleSize, y: style.subtitleY, bold: true, wordHighlight: style.karaoke,
        highlight: style.highlightColor, outline: 3 });
      const arabicTitle = /[\u0600-\u06ff]/.test(params.title);
      const titleCopy = wrap(params.title, arabicTitle ? 32 : 28), titleLength = Math.max(1,...titleCopy.split('\n').map(s => s.length));
      const titleSize = Math.floor(Math.min(style.titleSize*Math.min(1,29/titleLength), arabicTitle ? 200 : info.width*.86/(titleLength*.5)/(info.height/1920)));
      if (style.titleEnabled && params.title) track('Title', [{ text: titleCopy, start: 0,
        end: Math.min(info.duration, style.titleSeconds), position: 'top' }], { align: 'top', y: style.titleY,
        color: style.titleColor, size: titleSize, outline: 3, safeMarginX: 40 });
      if (style.ctaEnabled && params.cta) {
        const copy = wrap(params.cta, 31), longest = Math.max(...copy.split('\n').map(s => s.length));
        const size = Math.floor(style.ctaSize * Math.min(1,32/longest));
        if (size < 24) throw Error('Shorten the persistent invitation so it fits two readable lines without covering subtitles.');
        track('CTA', [{ text: copy, start: 0, end: info.duration, position: 'top' }],
        { align: 'top', y: style.ctaY, size, color: '#000000', boxed: true, background: '#ffffff',
          backgroundOpacity: 1, outlineColor: '#ffffff', outline: 4, shadow: 0, safeMarginX: 65 });
      }
      if (style.priceEnabled && params.price) track('Price', [{ text: params.price, start: 0, end: info.duration, position: 'top' }],
        { align: 'top', y: style.priceY, size: style.priceSize, color: '#000000', boxed: true, background: '#ffffff',
          backgroundOpacity: 1, outlineColor: '#ffffff', outline: 5 });
      if (!tracks.length) throw Error('No presentation tracks.');
      const header = tracks[0].ass.split('[V4+ Styles]')[0];
      const combined = header.replace('WrapStyle: 0','WrapStyle: 2') + '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
        + tracks.map(t => t.style).join('\n') + '\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' + tracks.flatMap(t => t.events).join('\n');
      const ass = path.join(store.projectDir(project.id), 'social_' + Date.now() + '.ass');
      fs.writeFileSync(ass, combined, 'utf8');
      const out = media.nextFile(project.id, 'social');
      ctx.progress('reference title, white invitation, top price and audio-timed karaoke', 88);
      await media.ff(['-i', file, '-vf', media.subsFilter(path.basename(ass)), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'copy', '-movflags', '+faststart', out], 900, path.dirname(ass));
      return { file: out, kind: 'video', params: { appearance: style, title: params.title, price: params.price, cta: params.cta, captionEvents: cap.length, referenceLayout: 'owner-images-v2' } };
    }
  };
}

function narrationWords(t) {
  if (t.timing !== 'audio_word_alignment') throw Error('Karaoke requires transcription of the actual audio, not generative timestamp estimates.');
  return (t.segments || []).flatMap(seg => {
    if (!seg.words?.length) throw Error('Missing spoken-word timestamps. Subtitle timing was not interpolated.');
    return seg.words.map(w => ({ text: w.text, start: w.start, end: w.end, estimated: false }));
  });
}
module.exports = { installSocialOps, narrationWords };
