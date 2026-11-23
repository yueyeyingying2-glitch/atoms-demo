import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);

const designs = [
  { name: '圆形', shape: '<circle cx="55" cy="44" r="21"/>', color: '#d79568' },
  { name: '三角形', shape: '<path d="M55 19 81 67H29Z"/>', color: '#73875d' },
  { name: '正方形', shape: '<rect x="34" y="23" width="42" height="42" rx="4"/>', color: '#a77b90' },
  { name: '菱形', shape: '<path d="M55 18 82 44 55 71 28 44Z"/>', color: '#8e92c9' },
  { name: '星形', shape: '<path d="m55 16 8 18 20 2-15 13 4 20-17-10-17 10 4-20-15-13 20-2Z"/>', color: '#c6a147' },
  { name: '十字形', shape: '<path d="M47 21h16v15h15v16H63v15H47V52H32V36h15Z"/>', color: '#658b8b' }
];

export async function createChallenge(store, session) {
  const shapes = designs.map((_, index) => index);
  for (let i = shapes.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shapes[i], shapes[j]] = [shapes[j], shapes[i]];
  }
  const position = randomInt(shapes.length);
  const id = await store.challenge(session, shapes, position);
  return { id, instruction: '请点击图中的' + designs[shapes[position]].name, image: '/api/challenge/' + id + '.svg' };
}

export function challengeImage(challenge) {
  const cells = JSON.parse(challenge.shapes).map((shape, i) => {
    const { shape: path, color } = designs[shape];
    return `<g transform="translate(${i % 3 * 110} ${Math.floor(i / 3) * 88})"><rect width="110" height="88"
      fill="${i % 2 ? '#f4f2e9' : '#f8f7ef'}" stroke="#e2dfd5"/><g fill="${color}" stroke="#353b32"
      stroke-width="2">${path}</g></g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="330" height="176" viewBox="0 0 330 176">${cells.join('')}</svg>`;
}

export function credentials(input) {
  const username = typeof input.username === 'string' ? input.username.trim().normalize('NFKC') : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (!/^[\p{L}\p{N}_-]{2,30}$/u.test(username) || password.length < 8 || password.length > 72) return null;
  return { username, handle: username.toLowerCase(), password };
}

export async function passwordDigest(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, digest: (await derive(password, salt, 64)).toString('hex') };
}

export async function passwordMatches(password, user) {
  const actual = await derive(password, user?.salt ?? '0'.repeat(32), 64);
  const expected = Buffer.from(user?.password_hash ?? '0'.repeat(128), 'hex');
  return timingSafeEqual(actual, expected) && Boolean(user);
}
