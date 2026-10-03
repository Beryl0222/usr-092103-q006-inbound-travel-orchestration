import { AssertionScope } from "../src/contracts.js";
import { Clock } from "../src/runtime/clock.js";
import { Platform } from "../src/runtime/platform.js";

export const PASSPORT = {
  surname: "SMITH",
  given_name: "JANE",
  passport_number: "E12345678",
  date_of_birth: "1990-06-01",
  nationality: "CAN",
  visa_class: "tourist_short_stay",
};

/** 构造一个已核验的平台与会话。 */
export function bootPlatform() {
  const clock = new Clock();
  const platform = new Platform(clock);
  const { session, sealedRef } = platform.verifyPassport({ rawPassport: PASSPORT, ttlMs: 1000 * 60 * 60 * 24 * 30 });
  return { platform, clock, session, sealedRef };
}

/** 授予并返回酒店授权 + 入住化名断言。 */
export function grantHotel(platform, sessionId, service = "hotel:pearl") {
  return platform.authorizeAndAssert({
    sessionId,
    service,
    purposes: ["入住登记"],
    scope: AssertionScope.HotelRegistrationAlias,
  });
}

export function grant(platform, sessionId, service, purposes, scope) {
  platform.sessions.grant({ sessionId, service, purposes, scopes: [scope] });
  return platform.sessions
    .listAuthorizations(sessionId)
    .find((a) => a.service === service && a.status === "active");
}

export function countEvents(platform, type) {
  return platform.events().filter((e) => e.event_type === type).length;
}

export function findEvents(platform, type) {
  return platform.events().filter((e) => e.event_type === type);
}
