# Primary sources

Checked September 8, 2026. Recheck these when changing collection or filing semantics.

- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces): configured-CIK submissions endpoint, recent filing columns and additional historical JSON files. SEC describes typical source update delays, which are not a service-level guarantee for our end-to-end collection.
- [SEC developer resources](https://www.sec.gov/about/developer-resources): fair access limits apply across the user's machines. Native collection defaults below the stated 10 requests/second ceiling; operator-wide coordination remains necessary for multiple collectors.
- [SEC webmaster FAQ](https://www.sec.gov/about/webmaster-frequently-asked-questions): declaring automated clients, timestamps, publication lag and obtaining filings. The collector uses source-provided acceptance timezone or retains it as unresolved rather than guessing.
- [SEC Form 4 instructions](https://www.sec.gov/files/form4.pdf): reporting dates, amendments, transaction/ownership fields, noncash consideration and footnotes. Filing arrival is not the underlying trade time; amended rows must be reconciled instead of blindly summed.
- [SEC ownership transaction codes](https://www.sec.gov/edgar/searchedgar/ownershipformcodes.html): purchase/sale codes cover open-market or private transactions; grant, exercise and withholding classifications have different meanings.
- [SEC filing technical specifications](https://www.sec.gov/submit-filings/technical-specifications): current ownership XML versions and schema evolution. Unknown fields are retained so newer attributes are not silently erased.
- [Robinhood stock-token integration](https://docs.robinhood.com/chain/building-with-stock-tokens/): exact token identity, stock-token corporate-action representation and integration context. CATALYST does not derive a security-to-token binding from ticker text or independently calculate corporate-action adjustments.

No SEC network collection was executed during the bundled demo or test suite. The XML fixture and onchain mapping/price observations are synthetic, with explicit evidence labels. Runtime correctness tests are separate from claims of live source reachability, latency, universe completeness or profitability.
