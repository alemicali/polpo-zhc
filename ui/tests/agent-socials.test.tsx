import { describe, expect, it } from "vitest";
import { socialKind, socialLink } from "@/lib/social-links";

describe("agent socials links", () => {
  it("maps platform keys and aliases", () => {
    expect(socialKind("Instagram")).toBe("instagram");
    expect(socialKind("twitter")).toBe("x");
    expect(socialKind("Sito")).toBe("website");
    expect(socialKind("myspace")).toBe("other");
  });

  it("uses the URL inside a value and shows the handle", () => {
    expect(socialLink("instagram", "@nina.ferraro_ (https://www.instagram.com/nina.ferraro_/)")).toEqual({
      kind: "instagram", text: "@nina.ferraro_", href: "https://www.instagram.com/nina.ferraro_/",
    });
    expect(socialLink("facebook", "https://www.facebook.com/profile.php?id=61596808164187")).toMatchObject({
      href: "https://www.facebook.com/profile.php?id=61596808164187", text: "facebook.com/profile.php?id=61596808164187",
    });
  });

  it("builds profile links from handles", () => {
    expect(socialLink("x", "@alice").href).toBe("https://x.com/alice");
    expect(socialLink("tiktok", "alice").href).toBe("https://www.tiktok.com/@alice");
    expect(socialLink("whatsapp", "+39 333 123 4567").href).toBe("https://wa.me/393331234567");
    expect(socialLink("website", "alice.dev").href).toBe("https://alice.dev/");
    expect(socialLink("email", "a@b.it").href).toBe("mailto:a@b.it");
  });

  it("never links anything but http(s)", () => {
    expect(socialLink("website", "javascript:alert(1)").href).toBeUndefined();
    expect(socialLink("other", "just some text").href).toBeUndefined();
  });
});
