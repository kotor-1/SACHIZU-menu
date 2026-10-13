import { describe, expect, it } from "vitest";
import { extractYouTubeVideoId } from "@/lib/youtube";

describe("extractYouTubeVideoId", () => {
  it("extracts ID from standard youtu.be format", () => {
    expect(extractYouTubeVideoId("https://youtu.be/6nZjgmr9ovA")).toBe("6nZjgmr9ovA");
    expect(extractYouTubeVideoId("http://youtu.be/6nZjgmr9ovA")).toBe("6nZjgmr9ovA");
    expect(extractYouTubeVideoId("youtu.be/6nZjgmr9ovA")).toBe("6nZjgmr9ovA");
  });

  it("extracts ID from youtu.be with query parameters", () => {
    expect(extractYouTubeVideoId("https://youtu.be/6nZjgmr9ovA?si=abcdef12345")).toBe(
      "6nZjgmr9ovA",
    );
    expect(extractYouTubeVideoId("https://youtu.be/6nZjgmr9ovA?t=15s")).toBe("6nZjgmr9ovA");
  });

  it("extracts ID from youtube.com/watch format", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/watch?v=6nZjgmr9ovA")).toBe(
      "6nZjgmr9ovA",
    );
    expect(extractYouTubeVideoId("https://youtube.com/watch?v=6nZjgmr9ovA")).toBe(
      "6nZjgmr9ovA",
    );
    expect(extractYouTubeVideoId("https://m.youtube.com/watch?v=6nZjgmr9ovA")).toBe(
      "6nZjgmr9ovA",
    );
  });

  it("extracts ID from youtube.com/watch with additional parameters", () => {
    expect(
      extractYouTubeVideoId("https://www.youtube.com/watch?v=6nZjgmr9ovA&feature=shared&t=10"),
    ).toBe("6nZjgmr9ovA");
    expect(
      extractYouTubeVideoId("https://www.youtube.com/watch?param=foo&v=6nZjgmr9ovA"),
    ).toBe("6nZjgmr9ovA");
  });

  it("extracts ID from youtube.com/shorts format", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/shorts/zsAoPhowDAw")).toBe(
      "zsAoPhowDAw",
    );
    expect(
      extractYouTubeVideoId("https://youtube.com/shorts/zsAoPhowDAw?feature=share"),
    ).toBe("zsAoPhowDAw");
  });

  it("extracts ID from embed format", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/embed/6nZjgmr9ovA")).toBe(
      "6nZjgmr9ovA",
    );
    expect(
      extractYouTubeVideoId("https://www.youtube-nocookie.com/embed/6nZjgmr9ovA"),
    ).toBe("6nZjgmr9ovA");
  });

  it("returns null for non-youtube URLs or invalid video IDs", () => {
    expect(extractYouTubeVideoId("https://example.com/video/6nZjgmr9ovA")).toBeNull();
    expect(extractYouTubeVideoId("https://vimeo.com/12345678")).toBeNull();
    expect(extractYouTubeVideoId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(extractYouTubeVideoId("not a url")).toBeNull();
  });

  it("returns null for empty or nullish values", () => {
    expect(extractYouTubeVideoId("")).toBeNull();
    expect(extractYouTubeVideoId("   ")).toBeNull();
    expect(extractYouTubeVideoId(null)).toBeNull();
    expect(extractYouTubeVideoId(undefined)).toBeNull();
  });
});
