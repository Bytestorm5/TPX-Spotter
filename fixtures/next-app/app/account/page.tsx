export const metadata = { title: "Account — Acme Outfitters" };

/** Privacy fixture: masked and blocked regions, and inputs whose values must never leave the page. */
export default function Account() {
  return (
    <>
      <h1>Your account</h1>
      <p className="lede">Private details stay private: Spotter masks and blocks these regions before anything is captured.</p>
      <div className="sensitive">
        <div className="card masked" data-spotter-mask data-testid="masked">
          <h2>Payment method</h2>
          <p>Visa ending 4242 · expires 08/29 · Ada Lovelace</p>
        </div>
        <div className="card blocked" data-spotter-block data-testid="blocked">
          <h2>Recovery codes</h2>
          <p>7F3K-99QA · 1LMX-4Z0P · Q8RR-2NV6</p>
        </div>
        <form className="form card" onSubmit={(e) => e.preventDefault()}>
          <label>
            Phone
            <input name="phone" defaultValue="+44 20 7946 0958" data-testid="phone" />
          </label>
          <label>
            Unmasked nickname
            <input name="nickname" defaultValue="ada" data-spotter-unmask />
          </label>
        </form>
      </div>
    </>
  );
}
