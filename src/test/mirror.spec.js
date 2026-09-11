import { expect } from "chai";
import { originalGitHubURL } from "@/kit/mirror";

describe("kit/mirror", function () {
    describe("originalGitHubURL", function () {
        it("unwraps a ghp.ci wrapper around raw.githubusercontent.com", function () {
            const result = originalGitHubURL(
                "https://ghp.ci/https://raw.githubusercontent.com/user/repo/main/rules.list",
            );
            expect(result).to.be.an.instanceOf(URL);
            expect(result.href).to.equal(
                "https://raw.githubusercontent.com/user/repo/main/rules.list",
            );
        });

        it("unwraps a ghp.ci wrapper around gist.githubusercontent.com", function () {
            const result = originalGitHubURL(
                "https://ghp.ci/https://gist.githubusercontent.com/user/abc123/raw/file.list",
            );
            expect(result).to.be.an.instanceOf(URL);
            expect(result.href).to.equal(
                "https://gist.githubusercontent.com/user/abc123/raw/file.list",
            );
        });

        it("returns null for a non-ghp.ci host", function () {
            expect(originalGitHubURL("https://example.com/https://raw.githubusercontent.com/a/b/c/d")).to.be.null;
        });

        it("returns null for http:// (not https)", function () {
            expect(originalGitHubURL("http://ghp.ci/https://raw.githubusercontent.com/a/b/c/d")).to.be.null;
        });

        it("returns null when the inner URL is not a GitHub host", function () {
            expect(originalGitHubURL("https://ghp.ci/https://example.com/a/b/c/d")).to.be.null;
        });

        it("returns null when the inner URL is http", function () {
            expect(originalGitHubURL("https://ghp.ci/http://raw.githubusercontent.com/a/b/c/d")).to.be.null;
        });

        it("returns null when the wrapper has credentials", function () {
            expect(originalGitHubURL("https://user:pass@ghp.ci/https://raw.githubusercontent.com/a/b/c/d")).to.be.null;
        });

        it("returns null when the wrapper has query parameters", function () {
            expect(originalGitHubURL("https://ghp.ci/https://raw.githubusercontent.com/a/b/c/d?token=abc")).to.be.null;
        });

        it("returns null when the inner URL has query parameters", function () {
            expect(originalGitHubURL("https://ghp.ci/https://raw.githubusercontent.com/a/b/c/d?x=1")).to.be.null;
        });

        it("returns null when the inner path has fewer than 4 components", function () {
            expect(originalGitHubURL("https://ghp.ci/https://raw.githubusercontent.com/a/b")).to.be.null;
        });

        it("returns null for a non-string, non-URL input", function () {
            expect(originalGitHubURL(null)).to.be.null;
            expect(originalGitHubURL(undefined)).to.be.null;
            expect(originalGitHubURL(42)).to.be.null;
        });

        it("returns null for an unparseable URL string", function () {
            expect(originalGitHubURL("not-a-url")).to.be.null;
        });

        it("accepts a URL object", function () {
            const url = new URL("https://ghp.ci/https://raw.githubusercontent.com/user/repo/branch/file.txt");
            const result = originalGitHubURL(url);
            expect(result).to.be.an.instanceOf(URL);
            expect(result.host).to.equal("raw.githubusercontent.com");
        });

        it("returns null for a ghp.ci URL with a non-default port", function () {
            expect(originalGitHubURL("https://ghp.ci:8080/https://raw.githubusercontent.com/a/b/c/d")).to.be.null;
        });
    });
});
