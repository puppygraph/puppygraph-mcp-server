import { describe, expect, it } from "vitest";
import {
  collectSecrets,
  maskSecrets,
  redactUri,
  scrubText,
} from "../../src/utils/redact.js";

describe("credential redaction", () => {
  it("masks credential fields at any depth and leaves other fields alone", () => {
    expect(
      maskSecrets({
        catalogs: [
          {
            name: "lake",
            jdbc: { username: "u", password: "p4ssword", jdbcUri: "jdbc:postgresql://h/db" },
            storage: { accessKey: "AKIA123", secretKey: "s3cr3t", region: "us-east-1" },
            rest: { client_secret: "cs-1234", token: "tok-1234", sasToken: "sas-1234" },
          },
        ],
      }),
    ).toEqual({
      catalogs: [
        {
          name: "lake",
          jdbc: { username: "u", password: "******", jdbcUri: "jdbc:postgresql://h/db" },
          storage: { accessKey: "******", secretKey: "******", region: "us-east-1" },
          rest: { client_secret: "******", token: "******", sasToken: "******" },
        },
      ],
    });
  });

  it("redacts credentials embedded in URIs", () => {
    expect(redactUri("jdbc:mysql://admin:hunter22@db:3306/app")).toBe(
      "jdbc:mysql://admin:******@db:3306/app",
    );
    expect(
      redactUri("jdbc:snowflake://acct.snowflakecomputing.com/?user=u&password=pw12&private_key_pwd=k&db=x"),
    ).toBe("jdbc:snowflake://acct.snowflakecomputing.com/?user=u&password=******&private_key_pwd=******&db=x");
    expect(redactUri("jdbc:postgresql://db:5432/app")).toBe("jdbc:postgresql://db:5432/app");
  });

  it("scrubs known secrets from free text, ignoring very short ones", () => {
    expect(scrubText("auth failed for 'Sup3rSecret'", ["Sup3rSecret"])).toBe(
      "auth failed for '******'",
    );
    expect(scrubText("a b c", ["a"])).toBe("a b c");
  });

  it("collects the secret values of a payload, skipping masks", () => {
    expect(
      collectSecrets({
        catalogs: [{ jdbcPassword: "pw-1", jdbc: { password: "******" }, options: { secretKey: "sk-1" } }],
      }),
    ).toEqual(["pw-1", "sk-1"]);
  });
});
