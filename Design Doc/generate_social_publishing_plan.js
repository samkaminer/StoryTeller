const fs = require("fs");
const path = require("path");
const {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
  convertInchesToTwip,
} = require("docx");

const outPath = path.join(__dirname, "social-publishing-integration-plan.docx");

const colors = {
  ink: "0B2545",
  blue: "2E74B5",
  darkBlue: "1F4D78",
  gray: "5A626E",
  lightFill: "F2F4F7",
  calloutFill: "EDF3F9",
  border: "D5DCE6",
};

function para(children, options = {}) {
  return new Paragraph({
    children,
    spacing: {
      before: options.before ?? 0,
      after: options.after ?? 120,
      line: options.line ?? 276,
    },
    alignment: options.alignment,
    heading: options.heading,
    bullet: options.bullet,
    numbering: options.numbering,
  });
}

function text(value, options = {}) {
  return new TextRun({
    text: value,
    bold: options.bold,
    italics: options.italics,
    color: options.color,
    size: options.size,
    font: options.font || "Calibri",
  });
}

function heading(content, level = 1) {
  const config = {
    1: { size: 32, color: colors.blue, before: 320, after: 120 },
    2: { size: 26, color: colors.blue, before: 240, after: 100 },
    3: { size: 24, color: colors.darkBlue, before: 160, after: 80 },
  }[level];
  return para(
    [text(content, { bold: true, color: config.color, size: config.size })],
    { before: config.before, after: config.after, line: 240 }
  );
}

function bullets(items) {
  return items.map((item) =>
    para([text(item, { size: 22 })], {
      bullet: { level: 0 },
      after: 80,
      line: 276,
    })
  );
}

function numbers(items) {
  return items.map((item) =>
    para([text(item, { size: 22 })], {
      numbering: { reference: "storyteller-steps", level: 0 },
      after: 80,
      line: 276,
    })
  );
}

function makeCell(content, widthInches, options = {}) {
  return new TableCell({
    width: { size: convertInchesToTwip(widthInches), type: WidthType.DXA },
    verticalAlign: "center",
    shading: options.fill
      ? { type: "clear", color: "auto", fill: options.fill }
      : undefined,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 6, color: colors.border },
      bottom: { style: BorderStyle.SINGLE, size: 6, color: colors.border },
      left: { style: BorderStyle.SINGLE, size: 6, color: colors.border },
      right: { style: BorderStyle.SINGLE, size: 6, color: colors.border },
    },
    margins: {
      top: 90,
      bottom: 90,
      left: 120,
      right: 120,
    },
    children: Array.isArray(content) ? content : [content],
  });
}

function makeTable(headers, rows, widths) {
  return new Table({
    width: { size: convertInchesToTwip(6.5), type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((h, i) =>
          makeCell(
            para([text(h, { bold: true, color: colors.ink, size: 21 })], {
              after: 0,
              line: 240,
            }),
            widths[i],
            { fill: colors.lightFill }
          )
        ),
      }),
      ...rows.map(
        (row) =>
          new TableRow({
            children: row.map((val, i) =>
              makeCell(
                para(
                  [
                    text(val, {
                      bold: i === 0 && widths.length <= 3,
                      size: 21,
                    }),
                  ],
                  { after: 0, line: 252 }
                ),
                widths[i]
              )
            ),
          })
      ),
    ],
  });
}

const children = [];

children.push(
  para(
    [text("SOCIAL PUBLISHING INTEGRATION PLAN", { bold: true, color: colors.ink, size: 34 })],
    { after: 60, line: 240 }
  )
);
children.push(
  para(
    [text("TikTok + Instagram publishing for StoryTeller story takes", { color: colors.gray, size: 26 })],
    { after: 160, line: 240 }
  )
);

[
  ["Document Type", "Full design plan"],
  ["Prepared For", "StoryTeller product and engineering"],
  ["Primary Outcome", "Move from best-effort share links to reliable first-party publish flows"],
  ["Recommended Starting Scope", "TikTok draft upload + Instagram Reels publishing"],
  ["Date", "June 3, 2026"],
].forEach(([label, value]) => {
  children.push(
    para(
      [
        text(`${label}: `, { bold: true, size: 22 }),
        text(value, { size: 22 }),
      ],
      { after: 40, line: 240 }
    )
  );
});

children.push(para([], { before: 80, after: 160 }));

children.push(
  para(
    [
      text("Recommendation: ", { bold: true, color: colors.ink, size: 22 }),
      text(
        "Ship a two-track publishing product: TikTok draft upload first, Instagram Reels publishing first, and keep manual download/share as a fallback only. Treat both platforms as account-connected publishing integrations rather than simple share buttons.",
        { color: colors.ink, size: 22 }
      ),
    ],
    { before: 80, after: 160, line: 276 }
  )
);

children.push(heading("1. Executive Summary", 1));
children.push(
  para(
    [
      text(
        "StoryTeller now supports multiple recorded takes for a story, which creates a clean foundation for real social publishing. The next product step is to let a user choose a take and publish that specific take to supported short-form platforms through StoryTeller, with account connection, publish status, and failure recovery built into the workflow.",
        { size: 22 }
      ),
    ],
    { after: 120, line: 276 }
  )
);
children.push(
  ...bullets([
    "TikTok supports official content posting flows for both draft upload and direct post.",
    "Instagram supports official publishing for Reels on professional accounts through Meta’s publishing flow.",
    "Neither platform should be modeled as a generic URL-share target the way X or Facebook can be.",
    "The publish experience should become a dedicated product surface with connection state, caption entry, platform-specific options, and publish-status tracking.",
  ])
);

children.push(heading("2. Goals, Non-Goals, and Product Principles", 1));
children.push(heading("Goals", 2));
children.push(
  ...bullets([
    "Let a user choose a specific take and publish that take to TikTok or Instagram from StoryTeller.",
    "Provide a reliable account connection flow with recoverable token and permission handling.",
    "Expose publish status so users know whether the action is queued, uploaded, awaiting approval, posted, or failed.",
    "Keep the initial scope tight enough to ship without taking on every social-network edge case at once.",
  ])
);
children.push(heading("Non-Goals for V1", 2));
children.push(
  ...bullets([
    "Multi-platform scheduling.",
    "Cross-posting to every network from a single click.",
    "Advanced campaign analytics and attribution.",
    "Social inbox or comment management.",
    "Heavy caption templating, team approvals, or content calendars.",
  ])
);
children.push(heading("Product Principles", 2));
children.push(
  ...numbers([
    "The selected take is the core object. All publish actions attach to a take, not just a story.",
    "Platform connections belong to the authenticated StoryTeller user and should be reusable across stories.",
    "Publishing is server-side and stateful; the browser should never be the only system of record.",
    "Every platform action must have a visible status and a retry path.",
  ])
);

children.push(heading("3. Capability Comparison", 1));
children.push(
  makeTable(
    ["Platform", "Best V1 Mode", "Account Requirement", "Key Constraint", "Recommended Use"],
    [
      ["TikTok", "Draft upload", "TikTok user authorizes StoryTeller", "Direct post needs stronger review and audit posture for public visibility", "Get to market fast with reliable upload and creator review in TikTok"],
      ["TikTok", "Direct post", "TikTok user authorizes StoryTeller", "Unaudited direct-post clients may be restricted to private visibility", "Phase 2 after audit and QA hardening"],
      ["Instagram", "Reels publish", "Instagram professional account", "Professional-account and Meta permission requirements", "Primary Instagram path for vertical story videos"],
    ],
    [1.0, 1.2, 1.45, 1.65, 1.2]
  )
);
children.push(para([], { after: 120 }));

children.push(heading("4. Proposed End-User Experience", 1));
children.push(heading("Results Page Changes", 2));
children.push(
  ...bullets([
    "Keep the take selector as the first decision point.",
    "Split the action area into two groups: Share Link actions and Publish actions.",
    "Replace the current TikTok and Instagram share buttons with real publish cards that reflect connection state.",
    "Treat manual download as a fallback utility, not as the main publish experience.",
  ])
);
children.push(heading("Primary Flow", 2));
children.push(
  ...numbers([
    "User lands on the story results page and chooses a take.",
    "User clicks Publish to TikTok or Publish to Instagram.",
    "If not connected, StoryTeller launches the platform connection flow and returns the user to the selected take.",
    "User enters or edits caption text and platform options.",
    "User confirms publish.",
    "StoryTeller uploads the media server-side and shows live status.",
    "User sees a final state with success, failure, and retry options.",
  ])
);
children.push(heading("Recommended UI Surfaces", 2));
children.push(
  ...bullets([
    "Results-page publish drawer or modal for one-take publishing.",
    "Connected Accounts settings page for TikTok and Instagram.",
    "Publish history panel on each story or take.",
    "Optional archive-level filter for published vs. unpublished takes.",
  ])
);

children.push(heading("5. Product UI Detail", 1));
children.push(
  makeTable(
    ["Surface", "Purpose", "Required Elements"],
    [
      ["Results page", "Choose a take and start publish", "Take selector, publish cards, manual fallback download, publish status chip"],
      ["Publish drawer", "Configure and confirm a post", "Preview, caption, selected account, platform options, submit CTA"],
      ["Connected Accounts", "Manage account linkage", "Connect, reconnect, disconnect, token health, handle display"],
      ["Publish history", "Track outcomes and retries", "Platform, timestamp, selected take, state, retry button, error detail"],
    ],
    [1.35, 1.7, 3.45]
  )
);
children.push(para([], { after: 120 }));
children.push(heading("TikTok Publish Drawer Fields", 2));
children.push(
  ...bullets([
    "Connected TikTok account identity.",
    "Caption field that the user can edit before sending.",
    "Privacy selector driven by the creator-info response.",
    "Comment, duet, and stitch options when the account allows them.",
    "Disclosure label: Sent as draft to TikTok or directly posted to TikTok.",
  ])
);
children.push(heading("Instagram Publish Drawer Fields", 2));
children.push(
  ...bullets([
    "Connected Instagram account identity.",
    "Caption field.",
    "Share to feed toggle.",
    "Cover image or thumbnail offset selection.",
    "Future extensibility hooks for collaborators or tags.",
  ])
);

children.push(heading("6. System Architecture", 1));
children.push(
  para(
    [
      text(
        "The publishing system should sit next to the existing story media pipeline but remain logically separate from recording and results rendering. Recording creates takes; publishing consumes a selected take. That separation keeps the media pipeline stable while allowing platform-specific workflows to evolve independently.",
        { size: 22 }
      ),
    ],
    { after: 120, line: 276 }
  )
);
children.push(
  makeTable(
    ["Layer", "Responsibility"],
    [
      ["Frontend", "Connection state, selected take, publish forms, progress polling, success and failure UI"],
      ["API layer", "OAuth start and callback, validation, publish job creation, status lookup"],
      ["Publish workers", "Upload media, call platform APIs, refresh tokens, update publish records"],
      ["Persistence", "Store social accounts, publish jobs, platform responses, retry metadata"],
      ["Media storage", "Serve or stream the selected take into platform upload flows"],
    ],
    [1.2, 5.3]
  )
);
children.push(para([], { after: 120 }));

children.push(heading("7. Data Model", 1));
children.push(
  makeTable(
    ["Entity", "Core Fields"],
    [
      ["story_takes", "take_id, story_id, report_id, created_at, video_gcs, duration, is_latest"],
      ["social_accounts", "id, user_id, platform, platform_account_id, display_name, access_token, refresh_token, expires_at, scopes, status"],
      ["social_publishes", "id, story_id, take_id, social_account_id, platform, caption, status, platform_publish_id, platform_post_id, error_code, error_message, created_at, updated_at"],
      ["social_publish_events", "publish_id, event_type, payload, created_at"],
    ],
    [1.4, 5.1]
  )
);
children.push(para([], { after: 120 }));

children.push(heading("8. API Surface", 1));
children.push(
  ...bullets([
    "POST /api/social/tiktok/connect/start",
    "GET /api/social/tiktok/connect/callback",
    "POST /api/social/instagram/connect/start",
    "GET /api/social/instagram/connect/callback",
    "GET /api/social/accounts",
    "POST /api/stories/:storyId/takes/:takeId/publish/tiktok",
    "POST /api/stories/:storyId/takes/:takeId/publish/instagram",
    "GET /api/social/publishes/:publishId",
    "POST /api/social/webhooks/tiktok",
  ])
);

children.push(heading("9. TikTok Integration Plan", 1));
children.push(heading("Recommended Rollout", 2));
children.push(
  ...bullets([
    "Phase 1: TikTok draft upload only.",
    "Phase 2: TikTok direct post after audit and policy readiness.",
    "Phase 3: Publish history, analytics, and richer creator controls.",
  ])
);
children.push(heading("TikTok Server Sequence", 2));
children.push(
  ...numbers([
    "User connects TikTok and grants the required scope.",
    "StoryTeller stores the TikTok access token and account identifiers.",
    "On publish, StoryTeller fetches creator info to determine allowed privacy and interaction options.",
    "StoryTeller uploads the selected take using the content posting flow.",
    "StoryTeller stores the returned publish identifier.",
    "StoryTeller polls publish status or consumes webhook events until final resolution.",
    "StoryTeller updates the publish record and surfaces the outcome in-product.",
  ])
);
children.push(heading("TikTok Engineering Notes", 2));
children.push(
  ...bullets([
    "Use file upload from the server first; this avoids domain-verification coupling on initial launch.",
    "Respect creator-info-derived limits such as allowed privacy states and maximum duration.",
    "Keep user-editable caption text; prefilled text must remain editable.",
    "Do not overlay promotional watermarks or StoryTeller branding onto the exported media.",
  ])
);

children.push(heading("10. Instagram Integration Plan", 1));
children.push(heading("Recommended Rollout", 2));
children.push(
  ...bullets([
    "Phase 1: Instagram Reels publishing only.",
    "Phase 2: better cover selection and richer post options.",
    "Phase 3: additional media types only if product demand justifies them.",
  ])
);
children.push(heading("Instagram Server Sequence", 2));
children.push(
  ...numbers([
    "User connects an eligible Instagram account through Meta or Instagram auth.",
    "StoryTeller stores the Instagram account identifier and publish token.",
    "On publish, StoryTeller creates a Reels media container.",
    "StoryTeller uploads the selected take into the container, preferably with resumable upload.",
    "StoryTeller publishes the container.",
    "StoryTeller polls container or post state as needed and records the final outcome.",
  ])
);
children.push(heading("Instagram Engineering Notes", 2));
children.push(
  ...bullets([
    "Design the product around Reels because the current StoryTeller output is portrait-first short video.",
    "Use a preflight validator for format, size, duration, and cover-frame viability before calling Meta.",
    "Prefer server-side upload flow over fragile browser handoff behavior.",
  ])
);

children.push(heading("11. Media Pipeline Requirements", 1));
children.push(
  makeTable(
    ["Requirement", "Why it matters", "V1 decision"],
    [
      ["Stable selected-take asset", "Publishing must target one immutable media object", "Publish from the chosen take record, not generic story fields"],
      ["Known mime type and file size", "Platform upload endpoints need explicit file metadata", "Persist on take records or derive before publish"],
      ["Retry-safe access", "Long-running jobs must be able to re-read the media", "Server jobs pull from storage, not from browser state"],
      ["Cover support", "Both networks benefit from clean cover handling", "Store or derive thumb offset; add custom cover later"],
    ],
    [1.7, 2.2, 2.6]
  )
);
children.push(para([], { after: 120 }));

children.push(heading("12. Security, Policy, and Operations", 1));
children.push(
  ...bullets([
    "Encrypt stored access tokens and refresh tokens.",
    "Log publish attempts and platform responses without leaking secrets.",
    "Support token refresh and reconnect flows when scopes or tokens expire.",
    "Add rate-limit and retry policies around outbound platform calls.",
    "Prepare app-review materials early because both platforms gate production-grade publishing behind review and policy compliance.",
  ])
);

children.push(heading("13. Rollout Plan", 1));
children.push(
  makeTable(
    ["Phase", "Scope", "Exit Criteria"],
    [
      ["0", "Replace placeholder share behavior with explicit manual fallback messaging", "No misleading platform buttons remain"],
      ["1", "Connected accounts plus TikTok draft upload plus Instagram Reels publish", "A selected take can be published end-to-end on both networks"],
      ["2", "Publish history, retries, and better status surfaces", "Users can recover from common failures without support"],
      ["3", "TikTok direct post and richer controls", "Audit and compliance requirements are met"],
    ],
    [0.55, 3.4, 2.55]
  )
);
children.push(para([], { after: 120 }));

children.push(heading("14. Recommended Immediate Build Sequence", 1));
children.push(
  ...numbers([
    "Add first-class take identifiers and make all publish operations take-scoped.",
    "Build connected-account persistence and OAuth callback flows.",
    "Implement TikTok draft upload server flow.",
    "Implement Instagram Reels publish server flow.",
    "Add publish drawer UI and status polling.",
    "Add publish history and retry mechanics.",
    "Only then consider TikTok direct post.",
  ])
);

children.push(heading("15. Open Questions", 1));
children.push(
  ...bullets([
    "Should StoryTeller support one connected account per platform per user at launch, or allow multiple destinations?",
    "Do we want to store reusable caption drafts per story, per take, or per platform?",
    "Should publish history live on the results page only, or also in the archive?",
    "Do we want a future approval workflow before enabling direct post to public visibility on TikTok?",
  ])
);

const doc = new Document({
  numbering: {
    config: [
      {
        reference: "storyteller-steps",
        levels: [
          {
            level: 0,
            format: LevelFormat.DECIMAL,
            text: "%1.",
            alignment: AlignmentType.START,
            style: {
              paragraph: {
                indent: { left: 720, hanging: 260 },
                spacing: { after: 80, line: 276 },
              },
            },
          },
        ],
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(1),
            right: convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            left: convertInchesToTwip(1),
          },
        },
      },
      headers: {
        default: new Header({
          children: [
            para([text("StoryTeller Social Publishing Plan", { size: 18, color: colors.gray })], {
              alignment: AlignmentType.RIGHT,
              after: 0,
              line: 240,
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            para(
              [text("Design Plan  ", { size: 18, color: colors.gray }), new TextRun(PageNumber.CURRENT)],
              { alignment: AlignmentType.RIGHT, after: 0, line: 240 }
            ),
          ],
        }),
      },
      children,
    },
  ],
});

Packer.toBuffer(doc).then((buffer) => {
  fs.writeFileSync(outPath, buffer);
  process.stdout.write(outPath);
});
