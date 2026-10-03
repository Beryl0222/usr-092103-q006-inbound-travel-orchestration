import { buildPlatform } from "../src/app/platform.js";
import { resetIds } from "../src/platform/ids.js";

export const PASSPORT = {
  full_name: "ZHANG San",
  passport_number: "E12345678",
  nationality: "China",
  date_of_birth: "1990-05-01",
  sex: "M",
  passport_expiry: "2030-01-01",
};

export const VISA = { type: "L", validUntil: "2026-12-31" };

export function freshPlatform() {
  resetIds();
  return buildPlatform();
}

/** 完成“开会话 → 护照核验 → 服务授权”，返回常用句柄。 */
export function onboardedTraveler(
  p,
  {
    partyId = "hotel-lakeside",
    purpose = "lodging_checkin",
    scopes = ["lodging_checkin"],
    ttlMs,
  } = {},
) {
  const session = p.identity.openSession({ locale: "en" });
  const { vaultId } = p.identity.verifyPassport(session.id, PASSPORT, VISA);
  const grantOpts = { sessionId: session.id, vaultId, partyId, purpose, scopes };
  if (ttlMs) grantOpts.ttlMs = ttlMs;
  const auth = p.authorization.grant(grantOpts);
  return { platform: p, sessionId: session.id, vaultId, authId: auth.id };
}

export function countEvents(store, type) {
  return store.all().filter((e) => e.event_type === type).length;
}

export function findEvents(store, type) {
  return store.all().filter((e) => e.event_type === type);
}
