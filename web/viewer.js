// Trashbot 3D snippets viewer: static, prerendered snippets (snippets/, tools/build_snippets.py), three.js.
// Frames: robot-centric (x = robot forward at t0, y = left, z up, metres); camera numbers: azim deg CCW from x,
// elev deg, dist m (pedestrian view: azim / elev = offsets from the person's facing).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import GUI from 'lil-gui';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

const W = 1920, H = 1080, Q = 1e-4;  // canvas size; body vertex quantum (m)
const RINGS = [['ring045', 0.45], ['ring12', 1.2], ['ring36', 3.6]];
const TRAIL_W = 0.16, TRAIL_Z = 0.11;  // trajectory ribbon width / height above the ground (m)
const BOROUGH = { bronx: 'Bronx', brooklyn: 'Brooklyn', manhattan: 'Manhattan', queens: 'Queens', staten: 'Staten Island' };
const $ = id => document.getElementById(id);
const stage = $('stage'), ctx = stage.getContext('2d');
const deg = Math.PI / 180;
const status = msg => { $('status').textContent = msg; };
const progs = new Map();  // progress bars, one per task key; frac null removes it
function prog(key, frac, text) {
  if (frac == null) progs.delete(key); else progs.set(key, [frac, text]);
  $('progs').replaceChildren(...[...progs.values()].map(([f, t]) => {
    const d = document.createElement('div'); d.className = 'prog';
    d.innerHTML = `<div class="bar"><div class="fill" style="width:${Math.round(100 * Math.max(0, Math.min(1, f)))}%"></div></div>`;
    d.append(`${t} · ${Math.round(100 * f)}%`);
    return d;
  }));
}
const rgb = a => `rgb(${a[0]},${a[1]},${a[2]})`;
const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lin = h => new THREE.Color().setRGB(...hexToRgb(h).map(v => v / 255), THREE.LinearSRGBColorSpace);  // plain colours as linear factors (as render.py)

// ---------- parameters (kept per browser; URL query overrides, e.g. ?snippet=<id>&camera=pedestrian) ----------
const DEF = {
  snippet: '', camera: 'side', azim: 0, elev: 18, dist: 9, orbit: 0, fov: 35, track: false,
  model: 'wham', trail: -1, future: true, person: '#ffffff', trailColor: '#4d4d4d', trailOpacity: 1,
  robotTrailColor: '#4d61ff', robotTrailOpacity: 1, ring045: false, ring12: false, ring36: false,
  cloud: true, pointSize: 4.5, cloudOpacity: 0.3, cloudColor: 'rgb', cloudTint: '#7a7f88',
  bg: '#ffffff', ground: '#ffffff', groundDisc: true, groundRadius: 40, fadeStart: 0.65, fadeEnd: 0.95,
  grid: true, gridStep: 1, gridOpacity: 0.35,
  ambient: 0.35, key: 2.6, keyAzim: -37, keyElev: 58, fill: 0.8, shadows: true, shadowSoft: 2,
  env: 0, toneMapping: 'none', exposure: 1,
  title: false, badges: false, inset: false, pano: false, panoBox: true, panoWidth: 720, panoPos: 'bottom-left',
  speed: 1, ss: 2, stem: '',
};
const STORE = 'trashbot_hri_viewer';
let P = { ...DEF };
try { Object.assign(P, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch (e) {}
for (const [k, v] of new URLSearchParams(location.search)) {
  if (k in DEF) P[k] = typeof DEF[k] === 'number' ? +v : typeof DEF[k] === 'boolean' ? v === 'true' || v === '1' : v;
}
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(P)); } catch (e) {} };

// ---------- three.js scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(P.fov, W / H, 0.05, 300);
camera.up.set(0, 0, 1);
const envTex = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture;
const ambient = new THREE.AmbientLight(0xffffff, P.ambient);
const key = new THREE.DirectionalLight(0xfffaf2, P.key);
key.castShadow = true;
key.shadow.mapSize.set(4096, 4096);
key.shadow.bias = -0.0005;
key.shadow.normalBias = 0.02;
const fill = new THREE.DirectionalLight(0xd9e6ff, P.fill);
scene.add(ambient, key, key.target, fill, fill.target);

// ground disc faded radially into the background ("void"); grid faded the same way
const U = { uC: { value: new THREE.Vector2() }, uR: { value: 8 }, uBg: { value: new THREE.Vector3() },
  uFs: { value: 0.45 }, uFe: { value: 0.95 } };
const FADE = 'float f = clamp((length(vW.xy - uC) - uFs * uR) / ((uFe - uFs) * uR), 0.0, 1.0); f = f * f * (3.0 - 2.0 * f);';
const worldPos = sh => sh.vertexShader
  .replace('#include <common>', '#include <common>\nvarying vec3 vW;')
  .replace('#include <project_vertex>', '#include <project_vertex>\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
const groundMat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
groundMat.onBeforeCompile = sh => {
  Object.assign(sh.uniforms, U);
  sh.vertexShader = worldPos(sh);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vW; uniform vec2 uC; uniform float uR, uFs, uFe; uniform vec3 uBg;')
    .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${FADE}\ngl_FragColor.rgb = mix(gl_FragColor.rgb, uBg, f);`);
};
const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 128), groundMat);
ground.receiveShadow = true;
scene.add(ground);
const gridMat = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false });
gridMat.onBeforeCompile = sh => {
  Object.assign(sh.uniforms, U);
  sh.vertexShader = worldPos(sh);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vW; uniform vec2 uC; uniform float uR, uFs, uFe;')
    .replace('#include <fog_fragment>', `#include <fog_fragment>\n${FADE}\ngl_FragColor.a *= 1.0 - f;`);
};
let grid = null;
function buildGrid() {
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid = null; }
  if (!P.grid || !S) return;
  const gr = P.groundRadius || S.gr, st = Math.max(0.05, P.gridStep), v = [];
  const x0 = Math.floor((S.gc[0] - gr) / st) * st, x1 = S.gc[0] + gr;
  const y0 = Math.floor((S.gc[1] - gr) / st) * st, y1 = S.gc[1] + gr;
  for (let x = x0; x <= x1; x += st) v.push(x, y0, 0, x, y1, 0);
  for (let y = y0; y <= y1; y += st) v.push(x0, y, 0, x1, y, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  grid = new THREE.LineSegments(g, gridMat);
  grid.position.z = 0.002; grid.renderOrder = 1;
  scene.add(grid);
}

// scene point cloud (prefiltered: hand mask, alignment, radius)
const cloudMat = new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false });
let cloudPts = null;

const personMat = new THREE.MeshStandardMaterial({ roughness: 0.98, metalness: 0 });
const robot = new THREE.Group();
scene.add(robot);
let robotMats = [];
const trailMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
const futureMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
const robotTrailMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
const robotFutureMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
const ringMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false });
let body = null, ribbons = [], ringMeshes = [];

let S = null, VERTS = null, FACES = {}, INDEX = [], crops = [], panos = [];
let cur = 0, playing = false, tPlay = 0, exporting = false;

// ---------- loading ----------
const getBuf = url => fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.arrayBuffer(); });
async function faces(kind) {
  if (!FACES[kind]) FACES[kind] = new Uint32Array(await getBuf(`snippets/faces_${kind}.bin`));
  return FACES[kind];
}

async function loadSnippet(id) {
  status('loading ' + id + ' ...');
  const r = await fetch(`snippets/${id}/scene.json`);
  if (!r.ok) { status(`cannot open ${id}`); return; }
  const sc = await r.json();
  if (!sc.models.some(m => m.id === P.model)) P.model = sc.models[0]?.id;
  if (sc.media && !sc.media.blurred) sc.media = {};  // real frames only once faces are blurred (tools/blur_faces.py)
  S = sc; crops = []; panos = [];
  $('snipTitle').textContent = `${S.title}  ·  ${S.subtitle.split('  ·  3D')[0]}`;
  mediaCtls.forEach(c => c.hide());
  modelCtl = modelCtl.options(Object.fromEntries(S.models.map(m => [m.label, m.id]))).name('body').onChange(loadModel);
  modelCtl.updateDisplay();
  $('slider').max = S.T - 1;
  cur = Math.min(cur, S.T - 1);
  await loadModel(true);
  if (!robot.children.length) await loadRobot(S.robot_model);
  if (P._cameraFor !== id) setCameraDefaults();
  P._cameraFor = id;
  applyStatic();
  loadCloud(id);
  loadMedia(id);
  status(`${S.T} frames · ${S.fps} fps · ${S.cloud.n.toLocaleString()} scene points`);
  draw();
}

async function loadModel(initial) {
  const id = S.id, m = S.models.find(m => m.id === P.model);
  prog('body', 0.5, `${m.label} body`);
  const [q, f] = await Promise.all([getBuf(`snippets/${id}/body_${m.id}.bin`), faces(m.faces)]);
  prog('body', null);
  if (S.id !== id) return;
  const qi = new Int16Array(q), path = S.paths[m.id], V3 = m.V * 3;  // vertex = q * Q + (path x, path y, 0)
  VERTS = new Float32Array(qi.length);
  for (let t = 0; t < S.T; t++) {
    const [px, py] = path[t], o = t * V3;
    for (let k = 0; k < V3; k += 3) {
      VERTS[o + k] = qi[o + k] * Q + px; VERTS[o + k + 1] = qi[o + k + 1] * Q + py; VERTS[o + k + 2] = qi[o + k + 2] * Q;
    }
  }
  if (body) { scene.remove(body); body.geometry.dispose(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(V3), 3));
  g.setIndex(new THREE.BufferAttribute(f, 1));
  body = new THREE.Mesh(g, personMat);
  body.castShadow = body.receiveShadow = true;
  body.frustumCulled = false;
  scene.add(body);
  S.V = m.V;
  if (initial !== true) { save(); draw(); }
}

async function loadRobot(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const blank = tex => {  // all-zero map (the model's ORM map is blank)
    if (!tex || !tex.image) return false;
    const c = document.createElement('canvas'), im = tex.image;
    c.width = Math.min(64, im.width); c.height = Math.min(64, im.height);
    const g = c.getContext('2d'); g.drawImage(im, 0, 0, c.width, c.height);
    return g.getImageData(0, 0, c.width, c.height).data.every((v, i) => i % 4 === 3 || v === 0);
  };
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    const m = o.material;
    if (blank(m.aoMap)) m.aoMap = null;
    if (blank(m.roughnessMap)) { m.roughnessMap = null; m.metalnessMap = null; m.roughness = 0.6; }
    m.metalness = Math.min(m.metalness, 0.24);  // no environment light by default: metals render black
    m.needsUpdate = true;
    robotMats.push(m);
  });
  gltf.scene.rotation.x = Math.PI / 2;  // glTF y up -> z up
  robot.add(gltf.scene);
}

async function loadCloud(id) {
  if (cloudPts) { scene.remove(cloudPts); cloudPts.geometry.dispose(); cloudPts = null; }
  prog('cloud', 0.3, 'scene point cloud');
  try {
    const buf = await getBuf(`snippets/${id}/cloud.bin`), n = buf.byteLength / 15;  // xyz f32 (N, 3), rgb u8 (N, 3)
    if (S.id !== id) return;
    const c8 = new Uint8Array(buf, 12 * n, 3 * n), col = new Float32Array(3 * n);
    for (let i = 0; i < 3 * n; i++) col[i] = Math.pow(c8[i] / 255, 2.2);  // sRGB -> linear
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, 0, 3 * n), 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    cloudPts = new THREE.Points(g, cloudMat);
    cloudPts.frustumCulled = false;
    scene.add(cloudPts);
    applyCloud(); draw();
  } catch (e) { status(`scene point cloud: ${e}`); }
  prog('cloud', null);
}

async function loadMedia(id) {  // body crop / 360 frames, only when downloaded and face-blurred
  for (const [kind, set] of [['crop', a => { crops = a; }], ['pano', a => { panos = a; }]]) {
    const off = S.media?.[kind];
    if (!off) continue;
    prog(kind, 0.3, kind === 'crop' ? 'close-up frames' : '360 frames');
    try {
      const r = await fetch(`snippets/${id}/${kind}.jpgs`);
      if (!r.ok) { prog(kind, null); continue; }  // frames not downloaded (README): no overlay
      const buf = await r.arrayBuffer();
      const ims = await Promise.all(off.slice(0, -1).map((o, i) =>
        createImageBitmap(new Blob([buf.slice(o, off[i + 1])], { type: 'image/jpeg' }))));
      if (S.id === id) { set(ims); mediaCtls.forEach(c => c.show()); draw(); }
    } catch (e) { status(`${kind} frames: ${e}`); }
    prog(kind, null);
  }
}

// ---------- scene state ----------
function applyCloud() {
  if (!cloudPts) return;
  cloudPts.visible = P.cloud;
  if (cloudMat.vertexColors !== (P.cloudColor === 'rgb')) { cloudMat.vertexColors = P.cloudColor === 'rgb'; cloudMat.needsUpdate = true; }
  cloudMat.color.copy(P.cloudColor === 'rgb' ? new THREE.Color(1, 1, 1) : lin(P.cloudTint));
  cloudMat.size = P.pointSize; cloudMat.opacity = P.cloudOpacity;
}

function applyStatic() {
  if (!S) return;
  const gr = P.groundRadius || S.gr;
  ground.visible = P.groundDisc;
  ground.scale.set(gr, gr, 1);
  ground.position.set(S.gc[0], S.gc[1], 0);
  U.uC.value.set(S.gc[0], S.gc[1]); U.uR.value = gr; U.uFs.value = P.fadeStart; U.uFe.value = P.fadeEnd;
  U.uBg.value.set(...hexToRgb(P.bg).map(v => v / 255));
  scene.background = new THREE.Color(P.bg);
  groundMat.color.copy(lin(P.ground));
  personMat.color.copy(lin(P.person));
  trailMat.color.copy(lin(P.trailColor)); trailMat.opacity = P.trailOpacity;
  futureMat.color.copy(lin(P.trailColor)); futureMat.opacity = 0.3 * P.trailOpacity;  // path to come: fainter
  robotTrailMat.color.copy(lin(P.robotTrailColor)); robotTrailMat.opacity = P.robotTrailOpacity;
  robotFutureMat.color.copy(lin(P.robotTrailColor)); robotFutureMat.opacity = 0.3 * P.robotTrailOpacity;
  ringMat.color.copy(lin(P.robotTrailColor));
  ambient.intensity = P.ambient; key.intensity = P.key; fill.intensity = P.fill;
  const kd = new THREE.Vector3(Math.cos(P.keyAzim * deg) * Math.cos(P.keyElev * deg),
    Math.sin(P.keyAzim * deg) * Math.cos(P.keyElev * deg), Math.sin(P.keyElev * deg));
  const c = new THREE.Vector3(S.gc[0], S.gc[1], 0);
  key.position.copy(c).addScaledVector(kd, 30); key.target.position.copy(c);
  fill.position.copy(c).add(new THREE.Vector3(-kd.x, -kd.y, 0.5).normalize().multiplyScalar(30));
  fill.target.position.copy(c);
  key.castShadow = P.shadows; key.shadow.radius = P.shadowSoft;
  const sc = key.shadow.camera;
  sc.left = sc.bottom = -gr; sc.right = sc.top = gr; sc.near = 1; sc.far = 60; sc.updateProjectionMatrix();
  scene.environment = P.env > 0 ? envTex : null;
  for (const m of [personMat, groundMat, ...robotMats]) { m.envMapIntensity = P.env; m.needsUpdate = true; }
  renderer.toneMapping = { none: THREE.NoToneMapping, aces: THREE.ACESFilmicToneMapping,
    agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping }[P.toneMapping];
  renderer.toneMappingExposure = P.exposure;
  camera.fov = P.fov; camera.updateProjectionMatrix();
  for (const m of ringMeshes) { scene.remove(m); m.geometry.dispose(); }
  ringMeshes = RINGS.filter(([k]) => P[k]).map(([, r]) => {  // around the robot at the first frame
    const m = new THREE.Mesh(new THREE.RingGeometry(r - 0.015, r + 0.015, 128), ringMat);
    m.position.set(S.robot[0][0], S.robot[0][1], 0.003);
    m.renderOrder = 1;
    scene.add(m);
    return m;
  });
  buildGrid(); applyCloud();
  gridMat.color.set('#555'); gridMat.opacity = P.gridOpacity;
  save();
}

function setFrame(i) {
  const V3 = S.V * 3, pos = body.geometry.attributes.position;
  pos.array.set(VERTS.subarray(i * V3, (i + 1) * V3)); pos.needsUpdate = true;
  body.geometry.computeVertexNormals();
  robot.position.set(S.robot[i][0], S.robot[i][1], 0);
  robot.rotation.z = S.robot_heading[i];
  for (const m of ribbons) { scene.remove(m); m.geometry.dispose(); }
  const path = S.paths[P.model];
  ribbons = [
    P.trail !== 0 && i > 1 && ribbon(path.slice(P.trail < 0 ? 0 : Math.max(0, i - Math.round(P.trail * S.fps)), i + 1), TRAIL_W, 0.004 + TRAIL_Z, trailMat),
    P.future && i < S.T - 2 && ribbon(path.slice(i), TRAIL_W / 2, 0.004 + TRAIL_Z, futureMat),
    i > 1 && ribbon(S.robot.slice(0, i + 1), TRAIL_W, 0.0035 + TRAIL_Z, robotTrailMat),  // robot: whole trail, path to come
    i < S.T - 2 && ribbon(S.robot.slice(i), TRAIL_W / 2, 0.0035 + TRAIL_Z, robotFutureMat),
  ].filter(Boolean);
}

function ribbon(pts, width, z, mat) {  // flat strip along a ground track, front faces up
  if (pts.length < 2) return null;
  const n = pts.length, v = new Float32Array(n * 6), idx = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) + 1e-9; dx /= l; dy /= l;
    const nx = -dy * width / 2, ny = dx * width / 2;
    v.set([pts[i][0] + nx, pts[i][1] + ny, z], i * 3);
    v.set([pts[i][0] - nx, pts[i][1] - ny, z], (n + i) * 3);
    if (i < n - 1) idx.push(i, n + i, i + 1, i + 1, n + i, n + i + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(v, 3)); g.setIndex(idx);
  const m = new THREE.Mesh(g, mat); m.renderOrder = 1;
  scene.add(m);
  return m;
}

// ---------- cameras (side / wide / robot / follow / top as the source render.py; pedestrian: the person's eyes) ----------
const CAMERAS = { 'side': 'side', 'wide': 'wide', 'robot': 'robot', 'follow person': 'follow', 'top': 'top', 'pedestrian POV': 'pedestrian' };
function setCameraDefaults() {
  if (P.camera === 'pedestrian') Object.assign(P, { azim: 0, elev: -20, dist: 0, fov: 70 });
  else {
    [P.azim, P.elev, P.dist] = (P.track ? S.defaults_track : S.defaults)[P.camera];
    P.azim = Math.round(P.azim * 10) / 10; P.dist = Math.round(P.dist * 100) / 100; P.fov = 35;
  }
  camera.fov = P.fov; camera.updateProjectionMatrix();
  gui.controllersRecursive().forEach(c => c.updateDisplay());
}
const dir = (az, el) => new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el));
function cameraPose(i) {
  const prog = i / Math.max(1, S.T - 1), m = P.camera;
  if (m === 'pedestrian') {  // eye midpoint, 6 cm ahead (out of the head mesh), looking along the facing + offsets
    const pv = S.pov[P.model], yaw = pv.yaw[i];
    const eye = new THREE.Vector3(...pv.eye[i]).add(new THREE.Vector3(Math.cos(yaw), Math.sin(yaw), 0).multiplyScalar(0.06));
    return [eye, eye.clone().add(dir(yaw + P.azim * deg, P.elev * deg))];
  }
  if (!P.track) i = Math.floor((S.T - 1) / 2);  // fixed camera: placed as at the middle frame
  let azim = P.azim, tgt;
  if (m === 'wide') { azim += P.orbit * (prog - 0.5); tgt = new THREE.Vector3(...S.center); }
  else if (m === 'side') {
    azim += P.orbit * (prog - 0.5);
    tgt = P.track ? new THREE.Vector3(S.mid[i][0], S.mid[i][1], 0.75) : new THREE.Vector3(S.center[0], S.center[1], 0.75);
  } else if (m === 'top') tgt = new THREE.Vector3(...S.center);
  else if (m === 'robot') {
    const look = azim * deg, R = S.robot[i];
    tgt = new THREE.Vector3(R[0] + 4 * Math.cos(look), R[1] + 4 * Math.sin(look), 0.6);
    return [new THREE.Vector3(R[0], R[1], 1.1).addScaledVector(dir(look + Math.PI, P.elev * deg), P.dist), tgt];
  } else {  // follow
    azim += S.follow_hd[i] / deg + 180;
    const p = S.follow_p[i], R = S.robot[i];
    tgt = new THREE.Vector3(p[0] * 0.6 + R[0] * 0.4, p[1] * 0.6 + R[1] * 0.4, 0.8);
  }
  return [tgt.clone().addScaledVector(dir(azim * deg, P.elev * deg), P.dist), tgt];
}

// ---------- drawing (WebGL -> 2D canvas + overlay) ----------
function render3d(i, ss) {
  if (renderer.getPixelRatio() !== ss) renderer.setPixelRatio(ss);
  setFrame(i);
  const [eye, tgt] = cameraPose(i);
  camera.position.copy(eye); camera.lookAt(tgt);
  renderer.render(scene, camera);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(renderer.domElement, 0, 0, W, H);
  overlay(i);
}

function overlay(i) {
  ctx.textBaseline = 'top';
  if (P.title) {
    ctx.fillStyle = '#1e2026'; ctx.font = 'bold 30px Roboto, "DejaVu Sans", sans-serif';
    ctx.fillText(S.title, 28, 22);
    ctx.fillStyle = '#6e727c'; ctx.font = '18px Roboto, "DejaVu Sans", sans-serif';
    ctx.fillText(S.subtitle, 28, 62);
  }
  if (P.badges) {
    let x = W - 40;
    const items = [];
    if (S.dist[i] != null) items.push([`${S.dist[i].toFixed(1)} m`, S.colors.ui_person]);
    if (S.speed[i] != null) items.push([S.speed[i] > 0.1 ? 'robot moving' : 'robot stopped', S.colors.ui_robot]);
    ctx.font = 'bold 20px Roboto, "DejaVu Sans", sans-serif'; ctx.textAlign = 'right';
    for (const [txt, c] of items.reverse()) {
      const w = ctx.measureText(txt).width;
      ctx.fillStyle = rgb(c); ctx.beginPath(); ctx.roundRect(x - w - 9, 22, w + 18, 32, 10); ctx.fill();
      ctx.fillStyle = '#101115'; ctx.fillText(txt, x, 28);
      x -= w + 52;
    }
    ctx.textAlign = 'left';
  }
  if (P.pano && panos[i]) {  // 360 preview, person box (u1 > 1 across the seam) with its wrapped copies
    const im = panos[i], w = P.panoWidth, h = Math.round(w * im.height / im.width);
    const x0 = P.panoPos === 'top-right' ? W - 28 - w : 28, y0 = P.panoPos === 'bottom-left' ? H - 28 - h : 112;
    ctx.fillStyle = '#fff'; ctx.fillRect(x0 - 3, y0 - 3, w + 6, h + 6);
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
    ctx.drawImage(im, x0, y0, w, h);
    const b = S.box[i];
    if (P.panoBox && b) {
      ctx.strokeStyle = rgb(S.colors.ui_person); ctx.lineWidth = 3;
      for (const k of [-1, 0, 1]) ctx.strokeRect(x0 + (b[0] + k) * w, y0 + b[1] * h, (b[2] - b[0]) * w, (b[3] - b[1]) * h);
    }
    ctx.restore();
  }
  const im = crops[i];
  if (P.inset && im) {
    const ih = 360, iw = Math.round(im.width * ih / im.height), x0 = W - 28 - iw, y0 = H - 28 - ih;
    ctx.fillStyle = '#fff'; ctx.fillRect(x0 - 3, y0 - 3, iw + 6, ih + 6);
    ctx.drawImage(im, x0, y0, iw, ih);
  }
}

let raf = 0;
function draw() {
  if (!S || !body || raf || exporting) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    render3d(cur, 1);
    $('slider').value = cur;
    $('time').textContent = `${S.t_rel[cur] >= 0 ? '+' : ''}${S.t_rel[cur].toFixed(2)} s · ${cur + 1}/${S.T}`;
  });
}
let last = 0;
function tick(now) {
  if (playing && S && !exporting) {
    tPlay += (now - last) / 1000 * P.speed;
    const i = Math.floor(tPlay * S.fps) % S.T;
    if (i !== cur) { cur = i; draw(); }
  }
  last = now;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- interaction ----------
let drag = null;
stage.addEventListener('pointerdown', e => { stage.setPointerCapture(e.pointerId); drag = [e.clientX, e.clientY]; stage.classList.add('drag'); });
stage.addEventListener('pointerup', () => { drag = null; stage.classList.remove('drag'); save(); });
stage.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag[0], dy = e.clientY - drag[1];
  drag = [e.clientX, e.clientY];
  const pov = P.camera === 'pedestrian';  // first person: drag the view (look around); else orbit
  P.azim = Math.round((P.azim + (pov ? 0.15 : -0.3) * dx) * 10) / 10;
  P.elev = Math.round(Math.max(pov ? -80 : -5, Math.min(pov ? 80 : 89, P.elev + (pov ? 0.15 : 0.2) * dy)) * 10) / 10;
  camFolder.controllers.forEach(c => c.updateDisplay());
  draw();
});
stage.addEventListener('wheel', e => {
  e.preventDefault();
  if (P.camera === 'pedestrian') { P.fov = Math.round(Math.max(20, Math.min(110, P.fov * Math.exp(e.deltaY * 0.001)))); applyStatic(); }
  else P.dist = Math.round(Math.max(0.5, P.dist * Math.exp(e.deltaY * 0.001)) * 100) / 100;
  camFolder.controllers.forEach(c => c.updateDisplay());
  draw(); save();
}, { passive: false });
function togglePlay() { if (!S) return; playing = !playing; tPlay = cur / S.fps; $('play').textContent = playing ? 'Pause' : 'Play'; }
$('play').onclick = togglePlay;
$('slider').oninput = e => { cur = +e.target.value; tPlay = cur / S.fps; draw(); };
window.addEventListener('keydown', e => {
  if ((e.target.tagName === 'INPUT' && e.target.type !== 'range') || e.target.tagName === 'SELECT' || $('exportDlg').open) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'ArrowRight') { cur = Math.min(S.T - 1, cur + 1); draw(); }
  if (e.code === 'ArrowLeft') { cur = Math.max(0, cur - 1); draw(); }
});

// ---------- export (top bar button -> dialog; files are downloaded by the browser) ----------
const download = (blob, name) => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};
const defaultStem = () => `${S.id}_${P.camera}_${P.model}`;
$('exportBtn').onclick = () => {
  if (!S || exporting) return;
  $('xStem').value = P.stem || defaultStem(); $('xSpeed').value = P.speed; $('xSs').value = P.ss;
  const upd = () => {
    const vid = $('xFormat').value === 'mp4';
    $('xSpeed').disabled = !vid;
    $('xNote').textContent = vid ? (typeof VideoEncoder === 'undefined'
      ? 'This browser has no WebCodecs video encoder: use a recent Chrome, Edge, Firefox or Safari.'
      : `${S.T} frames at ${(S.fps * +$('xSpeed').value).toFixed(1)} fps, rendered offline (not real time).`)
      : `frame ${cur + 1} (${S.t_rel[cur].toFixed(2)} s).`;
  };
  $('xFormat').onchange = $('xSpeed').oninput = upd; upd();
  $('exportDlg').showModal();
};
$('exportDlg').addEventListener('close', () => {
  if ($('exportDlg').returnValue !== 'ok') return;
  const stem = $('xStem').value.trim().replace(/[^\w.+-]/g, '_') || defaultStem();
  P.speed = Math.max(0.1, Math.min(2, +$('xSpeed').value || 1)); P.ss = +$('xSs').value;
  P.stem = stem === defaultStem() ? '' : stem; save();
  ($('xFormat').value === 'mp4' ? exportVideo : exportStill)(stem);
});
async function exportStill(stem) {
  render3d(cur, P.ss);
  const blob = await new Promise(res => stage.toBlob(res, 'image/png'));
  download(blob, `${stem}_${S.t_rel[cur] >= 0 ? '+' : ''}${S.t_rel[cur].toFixed(1)}s.png`);
  render3d(cur, 1);
}
async function exportVideo(stem) {
  if (typeof VideoEncoder === 'undefined') { status('video export needs WebCodecs (recent Chrome, Edge, Firefox or Safari)'); return; }
  const fps = S.fps * P.speed, dt = 1e6 / fps;
  let config = null;
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028']) {  // H.264 high / main / baseline, level 4.0
    const c = { codec, width: W, height: H, bitrate: 16e6, framerate: fps };
    if ((await VideoEncoder.isConfigSupported(c).catch(() => ({}))).supported) { config = c; break; }
  }
  if (!config) { status('no H.264 encoder available in this browser'); return; }
  exporting = true; const wasPlaying = playing; playing = false;
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: W, height: H }, fastStart: 'in-memory' });
  let err = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { err = e; } });
  enc.configure(config);
  try {
    for (let i = 0; i < S.T && !err; i++) {
      render3d(i, P.ss);
      const frame = new VideoFrame(stage, { timestamp: Math.round(i * dt), duration: Math.round(dt) });
      enc.encode(frame, { keyFrame: i % 30 === 0 });
      frame.close();
      while (enc.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 5));
      prog('export', (i + 1) / S.T, `rendering ${i + 1}/${S.T}`);
      if (i % 4 === 0) await new Promise(r => setTimeout(r, 0));  // let the progress bar paint
    }
    await enc.flush();
    if (err) throw err;
    muxer.finalize();
    download(new Blob([muxer.target.buffer], { type: 'video/mp4' }), `${stem}.mp4`);
    status(`exported ${stem}.mp4 (${S.T} frames, ${fps.toFixed(1)} fps)`);
  } catch (e) { status('video export failed: ' + e); }
  enc.close?.();
  prog('export', null);
  exporting = false; playing = wasPlaying;
  render3d(cur, 1);
}

// ---------- snippet search (text, area, date) ----------
const F = { text: '', area: '', date: '' };
try { Object.assign(F, JSON.parse(localStorage.getItem(STORE + '_filter') || '{}')); } catch (e) {}
const nice = a => a.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const borough = a => BOROUGH[a.split('_')[0]] || nice(a.split('_')[0]);
const place = a => nice(a.split('_').slice(1).join('_')) || nice(a);
const hay = e => [e.id, e.area, borough(e.area), place(e.area), e.date, e.robot, e.video, 'p' + e.person].join(' ').toLowerCase();
function match(e, skip) {
  const words = F.text.toLowerCase().split(/\s+/).filter(Boolean);
  return (skip === 'area' || e.area.startsWith(F.area)) && (skip === 'date' || e.date.startsWith(F.date))
    && words.every(w => hay(e).includes(w));
}
function fillSelect(el, k, all, opts) {  // opts [[value, label]]; counts among the entries passing the other filters
  const pool = INDEX.filter(e => match(e, k));
  const n = v => pool.filter(e => (k === 'area' ? e.area : e.date).startsWith(v)).length;
  el.innerHTML = '';
  el.add(new Option(`${all} (${pool.length})`, ''));
  for (const [v, label] of opts) el.add(new Option(`${label} (${n(v)})`, v));
  if (![...el.options].some(o => o.value === F[k])) F[k] = '';
  el.value = F[k];
}
const uniq = a => [...new Set(a)].sort();
function refreshList() {
  const areas = uniq(INDEX.map(e => e.area)), dates = uniq(INDEX.map(e => e.date));
  fillSelect($('fArea'), 'area', 'all areas', uniq(areas.map(a => a.split('_')[0])).flatMap(b =>
    [[b + '_', BOROUGH[b] || nice(b)], ...areas.filter(a => a.startsWith(b + '_')).map(a => [a, ' ' + place(a)])]));
  fillSelect($('fDate'), 'date', 'all dates', uniq(dates.map(d => d.slice(0, 4))).flatMap(y =>
    [[y, y], ...dates.filter(d => d.startsWith(y)).map(d => [d, ' ' + d])]));
  const list = $('fList'), shown = INDEX.filter(e => match(e));
  list.innerHTML = '';
  for (const e of shown) {
    const o = new Option(`${e.date}  ${place(e.area)} (${borough(e.area)})  p${e.person}`, e.id);
    o.title = `${e.title}\n${e.robot} ${e.video} · person ${e.person} · ${e.dur} s`;
    list.add(o);
  }
  list.value = P.snippet;
  $('fCount').textContent = `${shown.length} / ${INDEX.length} snippets`;
  try { localStorage.setItem(STORE + '_filter', JSON.stringify(F)); } catch (e) {}
}
for (const [id, k] of [['fArea', 'area'], ['fDate', 'date']]) $(id).onchange = e => { F[k] = e.target.value; refreshList(); };
$('fText').value = F.text;
$('fText').oninput = e => { F.text = e.target.value; refreshList(); };
$('fList').onchange = e => { if (e.target.value) { P.snippet = e.target.value; save(); loadSnippet(P.snippet); } };

// ---------- GUI ----------
const gui = new GUI({ container: $('gui'), title: 'Display' });
const on = () => () => { applyStatic(); draw(); };
const camFolder = gui.addFolder('Camera');
camFolder.add(P, 'camera', CAMERAS).name('preset').onChange(() => { setCameraDefaults(); applyStatic(); draw(); });
camFolder.add(P, 'azim', -360, 360, 0.1).onChange(on());
camFolder.add(P, 'elev', -80, 89, 0.1).onChange(on());
camFolder.add(P, 'dist', 0, 60, 0.01).onChange(on());
camFolder.add(P, 'fov', 10, 110, 1).onChange(on());
camFolder.add(P, 'track').name('follow the action').onChange(() => { setCameraDefaults(); draw(); save(); });
camFolder.add(P, 'orbit', -180, 180, 1).name('orbit (side / wide)').onChange(on());
camFolder.add({ reset: () => { setCameraDefaults(); applyStatic(); draw(); } }, 'reset').name('reset to preset');
const px = gui.addFolder('Person');
let modelCtl = px.add(P, 'model', { WHAM: 'wham' }).name('body');
px.add(P, 'trail', -1, 10, 0.5).name('trail s (-1 all, 0 none)').onChange(on());
px.add(P, 'future').name('future path').onChange(on());
px.addColor(P, 'person').name('body colour').onChange(on());
px.addColor(P, 'trailColor').name('trajectory colour').onChange(on());
px.add(P, 'trailOpacity', 0, 1, 0.01).name('trajectory opacity').onChange(on());
const rb = gui.addFolder('Robot');
rb.addColor(P, 'robotTrailColor').name('trajectory colour').onChange(on());
rb.add(P, 'robotTrailOpacity', 0, 1, 0.01).name('trajectory opacity').onChange(on());
for (const [k, r] of RINGS) rb.add(P, k).name(`ring ${r} m`).onChange(on());
const cf = gui.addFolder('Scene point cloud');
cf.add(P, 'cloud').name('show').onChange(on());
cf.add(P, 'pointSize', 0.5, 10, 0.5).name('point size (px)').onChange(on());
cf.add(P, 'cloudOpacity', 0.05, 1, 0.05).name('opacity').onChange(on());
cf.add(P, 'cloudColor', ['rgb', 'uniform']).name('colour').onChange(on());
cf.addColor(P, 'cloudTint').name('uniform colour').onChange(on());
const sc = gui.addFolder('Scene & light');
sc.addColor(P, 'bg').name('background').onChange(on());
sc.add(P, 'groundDisc').name('ground disc').onChange(on());
sc.addColor(P, 'ground').onChange(on());
sc.add(P, 'groundRadius', 0, 80, 0.5).name('ground radius (0 auto)').onChange(on());
sc.add(P, 'fadeStart', 0, 1, 0.01).name('fade start').onChange(on());
sc.add(P, 'fadeEnd', 0, 1.5, 0.01).name('fade end').onChange(on());
sc.add(P, 'grid').name('ground grid').onChange(on());
sc.add(P, 'gridStep', 0.1, 5, 0.1).name('grid step (m)').onChange(on());
sc.add(P, 'gridOpacity', 0.02, 1, 0.01).name('grid opacity').onChange(on());
sc.add(P, 'ambient', 0, 3, 0.01).onChange(on());
sc.add(P, 'key', 0, 8, 0.05).name('key light').onChange(on());
sc.add(P, 'keyAzim', -180, 180, 1).name('key azim').onChange(on());
sc.add(P, 'keyElev', 5, 89, 1).name('key elev').onChange(on());
sc.add(P, 'fill', 0, 4, 0.05).name('fill light').onChange(on());
sc.add(P, 'shadows').onChange(on());
sc.add(P, 'shadowSoft', 0, 10, 0.5).name('shadow softness').onChange(on());
sc.add(P, 'env', 0, 2, 0.01).name('environment light').onChange(on());
sc.add(P, 'toneMapping', ['none', 'aces', 'agx', 'neutral']).name('tone mapping').onChange(on());
sc.add(P, 'exposure', 0.2, 3, 0.01).onChange(on());
sc.close();
const ov = gui.addFolder('Overlay');
ov.add(P, 'title').onChange(on());
ov.add(P, 'badges').name('distance / robot badges').onChange(on());
const mediaCtls = [
  ov.add(P, 'inset').name('close-up inset').onChange(on()),
  ov.add(P, 'pano').name('360 preview').onChange(on()),
  ov.add(P, 'panoBox').name('360: person box').onChange(on()),
  ov.add(P, 'panoWidth', 240, 1864, 8).name('360: width (px)').onChange(on()),
  ov.add(P, 'panoPos', ['bottom-left', 'top-left', 'top-right']).name('360: position').onChange(on())];
ov.close();
gui.add({ reset: () => { try { localStorage.removeItem(STORE); } catch (e) {} location.search = ''; } }, 'reset').name('reset all settings');

const ALL = await fetch('snippets/index.json').then(r => r.json()).catch(() => []);
const have = await Promise.all(ALL.map(e => fetch(`snippets/${e.id}/scene.json`, { method: 'HEAD' }).then(r => r.ok, () => false)));
INDEX = ALL.filter((e, i) => have[i]);  // snippets present (the others are downloaded separately, README)
if (INDEX.length < ALL.length) $('help').append(` · ${ALL.length - INDEX.length} more snippets and the video frames: see the README to download them.`);
if (!INDEX.length) status('no snippet found (snippets/index.json): serve the web/ folder over HTTP (see README)');
mediaCtls.forEach(c => c.hide());
if (!INDEX.some(e => e.id === P.snippet)) P.snippet = INDEX[0]?.id || '';
refreshList();
if (P.snippet) await loadSnippet(P.snippet);
