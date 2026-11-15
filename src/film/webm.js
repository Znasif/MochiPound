// A minimal WebM (Matroska) muxer for one video track, so the film camera can write WebCodecs' VP9/VP8 frames
// to a playable, seekable file in the browser with no library (2026-11-15). The file is laid out once, at the
// end, so every size and position is known: EBML header, then the Segment with a SeekHead, Info, Tracks,
// one Cluster per keyframe (or per 30 s), and Cues that point at each Cluster. Timestamps are in ms.

const ID = {
  EBML: 0x1a45dfa3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42f7, EBMLMaxIDLength: 0x42f2, EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  Info: 0x1549a966, TimestampScale: 0x2ad7b1, Duration: 0x4489, MuxingApp: 0x4d80, WritingApp: 0x5741,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5, TrackType: 0x83, FlagLacing: 0x9c,
  CodecID: 0x86, DefaultDuration: 0x23e383, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  Cluster: 0x1f43b675, Timestamp: 0xe7, SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1,
};
export const WEBM_IDS = ID;

const idBytes = (id) => { const b = []; for (let v = id; v > 0; v = Math.floor(v / 256)) b.unshift(v & 0xff); return b; };
// element sizes as 8-byte EBML integers (0x01 + 7 bytes): always valid, so a size never changes a layout
function sizeBytes(n) {
  const b = [0x01];
  for (let i = 6; i >= 0; i--) b.push(Math.floor(n / 2 ** (8 * i)) & 0xff);
  return b;
}
function uintBytes(n) { const b = []; let v = Math.max(0, Math.round(n)); do { b.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0); return b; }
const uint8 = (n) => { const b = new Array(8); let v = Math.round(n); for (let i = 7; i >= 0; i--) { b[i] = v & 0xff; v = Math.floor(v / 256); } return b; };
function floatBytes(x) { const a = new Uint8Array(8); new DataView(a.buffer).setFloat64(0, x); return [...a]; }
const text = (s) => [...new TextEncoder().encode(s)];

// an element from its id and its body: an array of byte arrays / Uint8Arrays (kept as parts, never copied)
function el(id, parts) {
  const body = Array.isArray(parts) ? parts : [parts];
  const size = body.reduce((n, p) => n + p.length, 0);
  return { parts: [Uint8Array.from([...idBytes(id), ...sizeBytes(size)]), ...body.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)))], size: idBytes(id).length + 8 + size };
}
const flat = (e) => e.parts; // an element's parts, for nesting
const nest = (...els) => els.flatMap(flat);
const u = (id, n) => el(id, [uintBytes(n)]);

export function createWebmMuxer({ width, height, codec = 'V_VP9', fps = 60, app = 'Mochitsuki film camera' }) {
  const frames = []; // { data: Uint8Array, ms, key }
  return {
    get frames() { return frames.length; },
    // one encoded frame; timestampUs from the encoder (microseconds), key = a keyframe
    add(data, timestampUs, key) {
      if (!frames.length && !key) throw new Error('a WebM track must start with a keyframe');
      frames.push({ data: data instanceof Uint8Array ? data : new Uint8Array(data), ms: Math.round(timestampUs / 1000), key: !!key });
    },
    // the file, as Blob parts (Uint8Arrays); new Blob(parts, { type: 'video/webm' })
    finish() {
      if (!frames.length) throw new Error('no frames');
      const frameMs = 1000 / fps, duration = frames[frames.length - 1].ms + frameMs;
      const header = el(ID.EBML, nest(u(ID.EBMLVersion, 1), u(ID.EBMLReadVersion, 1), u(ID.EBMLMaxIDLength, 4), u(ID.EBMLMaxSizeLength, 8),
        el(ID.DocType, [text('webm')]), u(ID.DocTypeVersion, 4), u(ID.DocTypeReadVersion, 2)));
      const info = el(ID.Info, nest(u(ID.TimestampScale, 1e6), el(ID.Duration, [floatBytes(duration)]), el(ID.MuxingApp, [text(app)]), el(ID.WritingApp, [text(app)])));
      const tracks = el(ID.Tracks, nest(el(ID.TrackEntry, nest(u(ID.TrackNumber, 1), u(ID.TrackUID, 1), u(ID.TrackType, 1), u(ID.FlagLacing, 0),
        el(ID.CodecID, [text(codec)]), u(ID.DefaultDuration, Math.round(1e9 / fps)), el(ID.Video, nest(u(ID.PixelWidth, width), u(ID.PixelHeight, height)))))));
      // clusters: a new one at each keyframe, or when a block's 16-bit relative timestamp would overflow
      const clusters = [];
      let cur = null;
      for (const f of frames) {
        if (!cur || (f.key && f.ms > cur.ms) || f.ms - cur.ms > 30000) { cur = { ms: f.ms, blocks: [] }; clusters.push(cur); }
        const rel = f.ms - cur.ms;
        cur.blocks.push(el(ID.SimpleBlock, [[0x81, (rel >> 8) & 0xff, rel & 0xff, f.key ? 0x80 : 0x00], f.data]));
      }
      const clusterEls = clusters.map((c) => ({ ms: c.ms, e: el(ID.Cluster, nest(u(ID.Timestamp, c.ms), ...c.blocks)) }));
      // the SeekHead has a fixed size (8-byte positions), so the layout is: SeekHead, Info, Tracks, Clusters, Cues
      const seek = (id, pos) => el(ID.Seek, nest(el(ID.SeekID, [idBytes(id)]), el(ID.SeekPosition, [uint8(pos)])));
      const seekHeadFor = (pInfo, pTracks, pCues) => el(ID.SeekHead, nest(seek(ID.Info, pInfo), seek(ID.Tracks, pTracks), seek(ID.Cues, pCues)));
      const seekSize = seekHeadFor(0, 0, 0).size;
      const posInfo = seekSize, posTracks = posInfo + info.size;
      let pos = posTracks + tracks.size;
      const cuePoints = clusterEls.map((c) => { const p = pos; pos += c.e.size; return el(ID.CuePoint, nest(u(ID.CueTime, c.ms), el(ID.CueTrackPositions, nest(u(ID.CueTrack, 1), u(ID.CueClusterPosition, p))))); });
      const cues = el(ID.Cues, nest(...cuePoints));
      const seekHead = seekHeadFor(posInfo, posTracks, pos);
      const segment = el(ID.Segment, nest(seekHead, info, tracks, ...clusterEls.map((c) => c.e), cues));
      return [...header.parts, ...segment.parts];
    },
  };
}
