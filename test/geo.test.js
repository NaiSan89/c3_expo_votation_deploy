import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters, validatePosition } from '../geo.js';

const config = { lat: -23.540972222222223, lng: -46.734, radius: 200, maxAccuracy: 50 };
const now = 1800000000000;
const center = { latitude: config.lat, longitude: config.lng, accuracy: 10, timestamp: now };

test('coordenada DMS corresponde ao centro configurado', () => {
  assert.ok(Math.abs(config.lat + 23 + 32 / 60 + 27.5 / 3600) < 1e-10);
  assert.ok(Math.abs(config.lng + 46 + 44 / 60 + 2.4 / 3600) < 1e-10);
  assert.equal(distanceMeters(config.lat, config.lng, config.lat, config.lng), 0);
});
test('presença central aceita; ponto a mais de 200 m recusado', () => {
  assert.equal(validatePosition(center, config, now).ok, true);
  assert.equal(validatePosition({ ...center, latitude: config.lat + .003 }, config, now).ok, false);
});
test('margem de erro precisa caber no raio e precisão máxima é respeitada', () => {
  const latitude = config.lat + 190 / 6371000 * 180 / Math.PI;
  assert.equal(validatePosition({ ...center, latitude, accuracy: 5 }, config, now).ok, true);
  assert.equal(validatePosition({ ...center, latitude, accuracy: 20 }, config, now).ok, false);
  assert.equal(validatePosition({ ...center, accuracy: 51 }, config, now).ok, false);
});
test('dados ausentes, adulterados, antigos ou muito futuros recusados', () => {
  for (const bad of [null, {}, { ...center, latitude: '0' }, { ...center, longitude: Infinity }, { ...center, latitude: 91 }, { ...center, longitude: -181 }, { ...center, accuracy: -1 }, { ...center, timestamp: now - 60001 }, { ...center, timestamp: now + 5001 }]) {
    assert.equal(validatePosition(bad, config, now).ok, false);
  }
});
