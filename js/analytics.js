/* ============================================================
   Cage Rules — playtest analytics (PostHog)
   ------------------------------------------------------------
   One thin wrapper so the rest of the game only ever calls
   Analytics.track('event', { ...props }). Everything here is a no-op when
   there is no project key, the CDN is blocked, or the player opted out, so
   the game never depends on it.

   Setup: paste your PostHog project API key (phc_...) into KEY below and set
   HOST to your project's ingestion host (US cloud: https://us.i.posthog.com,
   EU cloud: https://eu.i.posthog.com). Session replay with WebGL canvas
   capture is switched on so fights can be watched back; canvas recording
   also has to be enabled in the PostHog project settings (Session replay →
   Canvas capture).

   Opt out for a player: localStorage.setItem('cr_analytics', 'off') or load
   the page with ?analytics=0.
   ============================================================ */
(function () {
  'use strict';
  const KEY = 'phc_w3umGSdMCtryzgqA7SV8PWjsUmeKZYx8db9EnEg7yq5v';                                 // <-- your PostHog project API key (phc_...)
  const HOST = 'https://us.i.posthog.com';        // or https://eu.i.posthog.com
  const DEBUG = /[?&]analytics=debug/.test(location.search);

  const off = (function () {
    if (/[?&]analytics=0/.test(location.search)) return true;
    try { return localStorage.getItem('cr_analytics') === 'off'; } catch (_) { return false; }
  })();
  const enabled = !!KEY && !off;

  // PostHog's official snippet: queues calls until array.js arrives, so nothing is lost before load.
  if (enabled) {
    !function (t, e) { var o, n, p, r; e.__SV || (window.posthog = e, e._i = [], e.init = function (i, s, a) { function g(t, e) { var o = e.split("."); 2 == o.length && (t = t[o[0]], e = o[1]), t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))) } } (p = t.createElement("script")).type = "text/javascript", p.crossOrigin = "anonymous", p.async = !0, p.src = s.api_host.replace(".i.posthog.com", "-assets.i.posthog.com") + "/static/array.js", (r = t.getElementsByTagName("script")[0]).parentNode.insertBefore(p, r); var u = e; for (void 0 !== a ? u = e[a] = [] : a = "posthog", u.people = u.people || [], u.toString = function (t) { var e = "posthog"; return "posthog" !== a && (e += "." + a), t || (e += " (stub)"), e }, u.people.toString = function () { return u.toString(1) + ".people (stub)" }, o = "init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey canRenderSurveyAsync identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionManager.captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId captureTraceFeedback captureTraceMetric".split(" "), n = 0; n < o.length; n++) g(u, o[n]); e._i.push([i, s, a]) }, e.__SV = 1) }(document, window.posthog || []);
    posthog.init(KEY, {
      api_host: HOST,
      person_profiles: 'always',          // alpha testers are few: a profile per tester makes them easy to follow
      capture_pageview: false,            // the game is one page; screens are tracked by hand below
      capture_pageleave: true,
      autocapture: false,                 // menu clicks are tracked as named events instead
      disable_session_recording: false,
      session_recording: {
        recordCanvas: true,               // the fight is a WebGL canvas: without this a replay is a black screen
        canvasFps: 4,
        canvasQuality: '0.4',
        maskAllInputs: false,             // the feedback form is the only input; the report is sent anyway
        maskTextSelector: '#fbContact'    // ...except the "reply to" box
      },
      persistence: 'localStorage+cookie',
      loaded: function (ph) { if (DEBUG) ph.debug(); }
    });
  }

  const session = { started: Date.now(), fights: 0 };
  function base() {
    return {
      session_min: Math.round((Date.now() - session.started) / 6000) / 10,
      fights_this_session: session.fights
    };
  }
  const Analytics = {
    enabled,
    // a named event with whatever props the caller has; the base props ride along with every call
    track(name, props) {
      if (DEBUG) console.log('[analytics]', name, props || {});
      if (!enabled) return;
      try { posthog.capture(name, Object.assign(base(), props || {})); } catch (_) {}
    },
    // props attached to every event from now on (build, input device, ...)
    register(props) { if (enabled) try { posthog.register(props); } catch (_) {} },
    // person-level props (shown on the tester's profile in PostHog)
    person(props) { if (enabled) try { posthog.setPersonProperties(props); } catch (_) {} },
    // give the anonymous tester a readable name (their feedback contact or career fighter name)
    identify(id, props) { if (enabled && id) try { posthog.identify(String(id).slice(0, 80), props || {}); } catch (_) {} },
    fightStarted() { session.fights++; },
    replayUrl() { try { return enabled ? posthog.get_session_replay_url() : ''; } catch (_) { return ''; } },
    optOut() { try { localStorage.setItem('cr_analytics', 'off'); } catch (_) {} if (enabled) try { posthog.opt_out_capturing(); } catch (_) {} }
  };
  window.MMAAnalytics = Analytics;
})();
