import { expect, test } from "bun:test";
import { parseSimpleResponse } from "../../src/main/services/python-dependency-manager";

test("withdrawn MaiBot files cannot reappear via the Simple API versions field", () => {
  const versions = parseSimpleResponse("maibot", { contentType: "application/vnd.pypi.simple.v1+json", text: JSON.stringify({
    versions: ["1.3.8", "1.3.9", "2.0.0"], files: [
      { filename: "maibot-1.3.8-py3-none-any.whl", "requires-python": ">=3.12", yanked: false },
      { filename: "maibot-1.3.9-py3-none-any.whl", yanked: "broken release" },
      { filename: "maibot-2.0.0.tar.gz", yanked: true },
      { filename: "maibot-3.0.0.tar.gz", yanked: "" },
    ],
  }) });
  expect(versions.map((item) => item.version)).toEqual(["1.3.8"]);
  expect(versions[0].requiresPython).toEqual([">=3.12"]);
});

test("HTML mirrors preserve Python constraints, skip yanked files and merge multiple distributions", () => {
  const versions = parseSimpleResponse("maibot", { contentType: "text/html", text: `
    <a href="maibot-1.3.8-py3-none-any.whl" data-requires-python="&gt;=3.12">wheel</a>
    <a href="maibot-1.3.8.tar.gz" data-requires-python="&gt;=3.13">source</a>
    <a href="maibot-1.3.9-py3-none-any.whl" data-yanked="">withdrawn</a>
    <a href="maibot-2.0.0.tar.gz" data-yanked>withdrawn</a>
  ` });
  expect(versions.map((item) => item.version)).toEqual(["1.3.8"]);
  expect(versions[0].requiresPython).toEqual([">=3.12", ">=3.13"]);
});
