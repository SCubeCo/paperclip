import { describe, expect, it } from "vitest";
import {
  isOnboardingPath,
  resolveDirectOnboardingRedirect,
  resolveRouteOnboardingOptions,
  shouldRedirectCompanylessRouteToOnboarding,
} from "./onboarding-route";

describe("isOnboardingPath", () => {
  it("matches the global onboarding route", () => {
    expect(isOnboardingPath("/onboarding")).toBe(true);
  });

  it("matches a company-prefixed onboarding route", () => {
    expect(isOnboardingPath("/pap/onboarding")).toBe(true);
  });

  it("ignores non-onboarding routes", () => {
    expect(isOnboardingPath("/pap/dashboard")).toBe(false);
  });
});

describe("resolveRouteOnboardingOptions", () => {
  it("opens company creation for the global onboarding route", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/onboarding",
        companies: [],
      }),
    ).toEqual({ initialStep: 1 });
  });

  it("opens agent creation when the prefixed company exists", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/pap/onboarding",
        companyPrefix: "pap",
        companies: [{ id: "company-1", issuePrefix: "PAP" }],
      }),
    ).toEqual({ initialStep: 2, companyId: "company-1" });
  });

  it("falls back to company creation when the prefixed company is missing", () => {
    expect(
      resolveRouteOnboardingOptions({
        pathname: "/pap/onboarding",
        companyPrefix: "pap",
        companies: [],
      }),
    ).toEqual({ initialStep: 1 });
  });
});

describe("resolveDirectOnboardingRedirect", () => {
  it("redirects global onboarding to the selected company dashboard", () => {
    expect(
      resolveDirectOnboardingRedirect({
        pathname: "/onboarding",
        companies: [
          { id: "company-1", issuePrefix: "PAP" },
          { id: "company-2", issuePrefix: "OPS" },
        ],
        selectedCompanyId: "company-2",
      }),
    ).toBe("/OPS/dashboard");
  });

  it("redirects global onboarding to the first company when no selection exists", () => {
    expect(
      resolveDirectOnboardingRedirect({
        pathname: "/onboarding",
        companies: [{ id: "company-1", issuePrefix: "PAP" }],
      }),
    ).toBe("/PAP/dashboard");
  });

  it("does not redirect prefixed onboarding routes", () => {
    expect(
      resolveDirectOnboardingRedirect({
        pathname: "/pap/onboarding",
        companyPrefix: "pap",
        companies: [{ id: "company-1", issuePrefix: "PAP" }],
      }),
    ).toBeNull();
  });

  it("does not redirect when there are no companies", () => {
    expect(
      resolveDirectOnboardingRedirect({
        pathname: "/onboarding",
        companies: [],
      }),
    ).toBeNull();
  });
});

describe("shouldRedirectCompanylessRouteToOnboarding", () => {
  it("redirects companyless entry routes into onboarding", () => {
    expect(
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: "/",
        hasCompanies: false,
      }),
    ).toBe(true);
  });

  it("does not redirect when already on onboarding", () => {
    expect(
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: "/onboarding",
        hasCompanies: false,
      }),
    ).toBe(false);
  });

  it("does not redirect when companies exist", () => {
    expect(
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: "/issues",
        hasCompanies: true,
      }),
    ).toBe(false);
  });
});
