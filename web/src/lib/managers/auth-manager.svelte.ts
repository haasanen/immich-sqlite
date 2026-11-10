import {
  getAboutInfo,
  getMyPreferences,
  getMyUser,
  logout,
  type UserAdminResponseDto,
  type UserPreferencesResponseDto,
} from '@immich/sdk';
import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { Route } from '$lib/route';
import { isSharedLinkRoute } from '$lib/utils/navigation';

class AuthManager {
  isPurchased = $state(false);
  isSharedLink = $derived(isSharedLinkRoute(page.route?.id));
  params = $derived(this.isSharedLink ? { key: page.params.key, slug: page.params.slug } : {});

  #user = $state<UserAdminResponseDto>();
  #preferences = $state<UserPreferencesResponseDto>();
  #publicBrowse = $state(false);

  get authenticated() {
    return !!(this.#user && this.#preferences);
  }

  /**
   * Fork feature: true when the gallery was opened without a session cookie
   * and the server served the API anonymously (public LAN browse). Write
   * affordances must not be offered in this mode.
   */
  get publicBrowse() {
    return this.#publicBrowse;
  }

  get user() {
    if (!this.#user) {
      throw new TypeError('AuthManager.user is undefined');
    }

    return this.#user;
  }

  get preferences() {
    if (!this.#preferences) {
      throw new TypeError('AuthManager.preferences is undefined');
    }

    return this.#preferences;
  }

  constructor() {
    eventManager.on({
      SessionDelete: () => goto(Route.logout()),
    });
  }

  async load() {
    if (authManager.authenticated) {
      return;
    }

    if (!this.#hasAuthCookie()) {
      await this.#loadPublicBrowse();
      return;
    }

    return this.refresh();
  }

  /**
   * Fork feature (server/src/utils/public-browse.ts): with no session cookie,
   * probe the API anonymously. A public-browse server answers as the library
   * owner and the gallery opens straight from the site root; any 401 keeps
   * the regular login gate untouched.
   */
  async #loadPublicBrowse() {
    try {
      const [user, preferences] = await Promise.all([getMyUser(), getMyPreferences()]);
      this.#user = user;
      this.#preferences = preferences;
      this.#publicBrowse = true;
      eventManager.emit('AuthUserLoaded', user);
    } catch {
      // not public: authenticate() redirects to the login page as before
    }
  }

  async refresh() {
    try {
      const [user, preferences] = await Promise.all([getMyUser(), getMyPreferences()]);
      this.#preferences = preferences;
      this.#user = user;

      if (user.license?.activatedAt) {
        this.isPurchased = true;
      } else {
        // check server status
        const serverInfo = await getAboutInfo().catch(() => {});
        if (serverInfo?.licensed) {
          this.isPurchased = true;
        }
      }

      eventManager.emit('AuthUserLoaded', user);
    } catch {
      // noop
    }
  }

  setUser(user: UserAdminResponseDto) {
    this.#user = user;
  }

  setPreferences(preferences: UserPreferencesResponseDto) {
    this.#preferences = preferences;
  }

  async logout() {
    let redirectUri = Route.login();

    try {
      const response = await logout();
      if (response.redirectUri) {
        redirectUri = response.redirectUri;
      }
    } catch {
      // noop
    }

    if (redirectUri.startsWith('/')) {
      this.isPurchased = false;

      this.reset();
      eventManager.emit('AuthLogout');

      await goto(redirectUri);
    } else {
      location.assign(redirectUri);
    }
  }

  reset() {
    this.#user = undefined;
    this.#preferences = undefined;
    this.#publicBrowse = false;
  }

  #hasAuthCookie() {
    if (!browser) {
      return;
    }

    for (const cookie of document.cookie.split('; ')) {
      const [name] = cookie.split('=', 1);
      if (name === 'immich_is_authenticated') {
        return true;
      }
    }

    return false;
  }
}

export const authManager = new AuthManager();
