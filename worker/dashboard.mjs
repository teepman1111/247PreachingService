import dashboard from '../public/pastors.html';
import { tenantBase } from './tenants.mjs';

const signIn = '<a class="button" target="_top" href="/signin-with-chatgpt?return_to=%2F">Sign in with ChatGPT</a>';
const signOut = '<a target="_top" href="/signout-with-chatgpt?return_to=%2F">Sign out</a>';
const setup = `<section class="card">
  <h2>Create your church channel</h2>
  <p>You’ll get a public Watch link and a private Programming page to approve and schedule sermons.</p>
  <form id="setup">
    <label>Church name<input name="name" required maxlength="80" autocomplete="organization"></label>
    <label>Time zone<input name="timeZone" required maxlength="80" value="America/Chicago"><small>Use a name such as America/Chicago or Europe/London.</small></label>
    <div><button>Create channel</button></div>
    <p role="status" id="setup-status"></p>
  </form>
</section>`;

export function pastorDashboard(account, tenant, legacyOwner) {
  const base = tenant && tenantBase(tenant);
  const panel = base ? `<section class="card">
    <h2>Your church channel</h2>
    <div class="actions"><a class="button" href="${base}/programming">Manage programming</a>
    <a href="${base}/watch">Open public Watch page</a></div>
  </section>` : account ? setup : '';
  const legacy = legacyOwner ? `<section class="card">
    <h2>Original pilot channel</h2>
    <div class="actions"><a href="/programming">Manage the original channel</a><a href="/watch">Open original Watch page</a></div>
  </section>` : '';
  return dashboard.replace('<!-- account-nav -->', account ? signOut : '')
    .replace('<!-- hero-action -->', account ? '' : signIn)
    .replace('<!-- dashboard -->', panel + legacy);
}
