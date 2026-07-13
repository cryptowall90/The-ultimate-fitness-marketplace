/**
 * Program form fields shared by the create and edit forms. Rendered on the
 * server; plain HTML controls so the form works without client JS.
 */

export interface ProgramDefaults {
  slug: string;
  title: string;
  summary: string;
  full_description: string;
  delivery_mode: string;
  pricing_type: string;
  price_cents: number;
  duration_value: number;
  duration_unit: string;
  recurrence_interval: string | null;
  recurrence_interval_count: number | null;
  capacity: number | null;
  approval_policy: string;
  included_features: string[];
  cancellation_terms: string;
  refund_policy: string;
  visibility: string;
}

export function ProgramFormFields({ defaults }: { defaults?: ProgramDefaults }) {
  return (
    <>
      <div className="field">
        <label htmlFor="title">Title</label>
        <input
          id="title"
          name="title"
          className="input"
          defaultValue={defaults?.title ?? ""}
          minLength={3}
          maxLength={140}
          placeholder="e.g. 8-week strength kickstart"
          required
        />
      </div>
      <div className="field">
        <label htmlFor="slug">Program URL</label>
        <input
          id="slug"
          name="slug"
          className="input"
          defaultValue={defaults?.slug ?? ""}
          pattern="[a-z0-9][a-z0-9-]{1,80}"
          title="Lowercase letters, numbers and hyphens"
          placeholder="e.g. 8-week-kickstart"
          required
        />
      </div>
      <div className="field">
        <label htmlFor="summary">Summary</label>
        <textarea
          id="summary"
          name="summary"
          className="input"
          rows={2}
          defaultValue={defaults?.summary ?? ""}
          maxLength={500}
          placeholder="One or two sentences shown in search results"
        />
      </div>
      <div className="field">
        <label htmlFor="fullDescription">Full description</label>
        <textarea
          id="fullDescription"
          name="fullDescription"
          className="input"
          rows={8}
          defaultValue={defaults?.full_description ?? ""}
          maxLength={20000}
          placeholder="What's included, who it's for, how coaching works"
        />
      </div>
      <div className="field">
        <label htmlFor="deliveryMode">Delivery</label>
        <select
          id="deliveryMode"
          name="deliveryMode"
          className="input"
          defaultValue={defaults?.delivery_mode ?? "online"}
        >
          <option value="online">Online</option>
          <option value="in_person">In person</option>
          <option value="hybrid">Both</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="price">Price (USD)</label>
        <input
          id="price"
          name="price"
          className="input"
          inputMode="decimal"
          pattern="\$?\s*\d{1,6}(\.\d{1,2})?"
          defaultValue={defaults ? (defaults.price_cents / 100).toFixed(2) : ""}
          placeholder="e.g. 199.00"
          required
        />
      </div>
      <div className="field">
        <label htmlFor="pricingType">Pricing</label>
        <select
          id="pricingType"
          name="pricingType"
          className="input"
          defaultValue={defaults?.pricing_type ?? "one_time"}
        >
          <option value="one_time">One-time purchase</option>
          <option value="recurring">Recurring subscription</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="recurrenceInterval">Billing interval (recurring only)</label>
        <select
          id="recurrenceInterval"
          name="recurrenceInterval"
          className="input"
          defaultValue={defaults?.recurrence_interval ?? "month"}
        >
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="recurrenceIntervalCount">Billing every N intervals (recurring only)</label>
        <input
          id="recurrenceIntervalCount"
          name="recurrenceIntervalCount"
          className="input"
          type="number"
          min={1}
          max={12}
          defaultValue={defaults?.recurrence_interval_count ?? 1}
        />
      </div>
      <div className="field">
        <label htmlFor="durationValue">Program length</label>
        <input
          id="durationValue"
          name="durationValue"
          className="input"
          type="number"
          min={1}
          max={730}
          defaultValue={defaults?.duration_value ?? 8}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="durationUnit">Length unit</label>
        <select
          id="durationUnit"
          name="durationUnit"
          className="input"
          defaultValue={defaults?.duration_unit ?? "week"}
        >
          <option value="day">Days</option>
          <option value="week">Weeks</option>
          <option value="month">Months</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="capacity">Client capacity (optional)</label>
        <input
          id="capacity"
          name="capacity"
          className="input"
          type="number"
          min={1}
          max={10000}
          defaultValue={defaults?.capacity ?? ""}
          placeholder="Leave empty for unlimited"
        />
      </div>
      <div className="field">
        <label htmlFor="approvalPolicy">Enrollment</label>
        <select
          id="approvalPolicy"
          name="approvalPolicy"
          className="input"
          defaultValue={defaults?.approval_policy ?? "automatic"}
        >
          <option value="automatic">Automatic after payment</option>
          <option value="manual">I approve each client</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="includedFeatures">What’s included (one per line)</label>
        <textarea
          id="includedFeatures"
          name="includedFeatures"
          className="input"
          rows={4}
          defaultValue={(defaults?.included_features ?? []).join("\n")}
          placeholder={"Weekly check-ins\nCustom training plan\nChat support"}
        />
      </div>
      <div className="field">
        <label htmlFor="cancellationTerms">Cancellation terms</label>
        <textarea
          id="cancellationTerms"
          name="cancellationTerms"
          className="input"
          rows={2}
          defaultValue={defaults?.cancellation_terms ?? ""}
          maxLength={4000}
        />
      </div>
      <div className="field">
        <label htmlFor="refundPolicy">Refund policy</label>
        <textarea
          id="refundPolicy"
          name="refundPolicy"
          className="input"
          rows={2}
          defaultValue={defaults?.refund_policy ?? ""}
          maxLength={4000}
        />
      </div>
      <div className="field">
        <label htmlFor="visibility">Visibility</label>
        <select
          id="visibility"
          name="visibility"
          className="input"
          defaultValue={defaults?.visibility ?? "public"}
        >
          <option value="public">Public — shown in search</option>
          <option value="unlisted">Unlisted — link only</option>
        </select>
      </div>
    </>
  );
}
