<template>
    <div v-show="doShow" id="profile-selector-container" :data-app="app">
        <!-- Icon -->
        <div id="icon-container" class="bottomMargin">
            <svg
                v-if="app === 'AMAZONQ'"
                width="71"
                height="71"
                viewBox="0 0 71 71"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
            >
                <g clip-path="url(#clip0_331_37336)">
                    <path
                        d="M30.1307 1.46438L8.83068 13.7563C5.45818 15.7087 3.37256 19.3031 3.37256 23.2081V47.8067C3.37256 51.6969 5.45818 55.306 8.83068 57.2585L30.1307 69.5504C33.5032 71.5029 37.6596 71.5029 41.0321 69.5504L62.3321 57.2585C65.7046 55.306 67.7903 51.7117 67.7903 47.8067V23.2081C67.7903 19.3179 65.7046 15.7087 62.3321 13.7563L41.0321 1.46438C37.6596 -0.488125 33.5032 -0.488125 30.1307 1.46438Z"
                        fill="url(#paint0_linear_331_37336)"
                    />
                    <path
                        d="M54.1966 21.6843L38.2364 12.469C37.5116 12.0401 36.5354 11.833 35.5739 11.833C34.6124 11.833 33.651 12.0401 32.9114 12.469L16.9512 21.6843C15.4868 22.5274 14.2887 24.5982 14.2887 26.2845V44.7149C14.2887 46.4011 15.4868 48.472 16.9512 49.3151L32.9114 58.5303C33.6362 58.9593 34.6124 59.1663 35.5739 59.1663C36.5354 59.1663 37.4968 58.9593 38.2364 58.5303L54.1966 49.3151C55.661 48.472 56.8591 46.4011 56.8591 44.7149V26.2845C56.8591 24.5982 55.661 22.5274 54.1966 21.6843ZM36.0029 54.7141C36.0029 54.7141 35.7958 54.7584 35.5887 54.7584C35.3816 54.7584 35.2337 54.7288 35.1745 54.7141L19.1699 45.4693C19.0072 45.3213 18.8002 44.9515 18.7558 44.7445V26.2549C18.8002 26.0478 19.022 25.678 19.1699 25.5301L35.1745 16.2853C35.1745 16.2853 35.3816 16.2409 35.5887 16.2409C35.7958 16.2409 35.9437 16.2705 36.0029 16.2853L52.0075 25.5301C52.1702 25.678 52.3772 26.0478 52.4216 26.2549V42.6588L40.0262 35.4997V33.5472C40.0262 33.1626 39.8191 32.8224 39.4937 32.6301L36.1212 30.6776C35.9585 30.5888 35.7662 30.5297 35.5887 30.5297C35.4112 30.5297 35.2189 30.574 35.0562 30.6776L31.6837 32.6301C31.3583 32.8224 31.1512 33.1774 31.1512 33.5472V37.4374C31.1512 37.822 31.3583 38.1622 31.6837 38.3545L35.0562 40.307C35.2189 40.3957 35.4112 40.4549 35.5887 40.4549C35.7662 40.4549 35.9585 40.4105 36.1212 40.307L37.8074 39.3307L50.2029 46.4899L36.0029 54.6845V54.7141Z"
                        fill="white"
                    />
                </g>
                <defs>
                    <linearGradient
                        id="paint0_linear_331_37336"
                        x1="64.1515"
                        y1="-5.31021"
                        x2="10.5465"
                        y2="71.2515"
                        gradientUnits="userSpaceOnUse"
                    >
                        <stop stop-color="#A7F8FF" />
                        <stop offset="0.03" stop-color="#9DF1FF" />
                        <stop offset="0.08" stop-color="#84E1FF" />
                        <stop offset="0.15" stop-color="#5AC7FF" />
                        <stop offset="0.22" stop-color="#21A2FF" />
                        <stop offset="0.26" stop-color="#008DFF" />
                        <stop offset="0.66" stop-color="#7F33FF" />
                        <stop offset="0.99" stop-color="#39127D" />
                    </linearGradient>
                    <clipPath id="clip0_331_37336">
                        <rect width="71" height="71" fill="white" />
                    </clipPath>
                </defs>
            </svg>
        </div>

        <template v-if="isFirstLoading">
            <div class="header bottomMargin">Fetching Q Developer profiles...this may take a minute.</div>
        </template>

        <template v-else-if="isNotAcceptingNewCustomers">
            <div id="blocked-screen">
                <div class="blocked-heading">New sign-ups are no longer available</div>
                <div class="blocked-subheading">
                    Amazon Q Developer stopped accepting new accounts as of {{ signupCutoffDate }}.
                </div>

                <section class="blocked-card blocked-card-info">
                    <h3 class="blocked-card-title">
                        <svg class="blocked-icon" viewBox="0 0 16 16" aria-hidden="true">
                            <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5" />
                            <rect x="7.25" y="6.75" width="1.5" height="5" rx="0.6" fill="currentColor" />
                            <circle cx="8" cy="4.6" r="1" fill="currentColor" />
                        </svg>
                        Why am I seeing this?
                    </h3>
                    <p class="blocked-card-body">
                        Amazon Q Developer IDE plugins are reaching end of support on {{ endOfSupportDate }}. New
                        Builder ID accounts created after {{ signupCutoffDate }} can no longer access Q Developer.
                        <a class="blocked-inline-link" :href="announcementUrl">Read the announcement &rarr;</a>
                    </p>
                </section>

                <section class="blocked-card blocked-card-highlight">
                    <h3 class="blocked-card-title blocked-card-title-highlight">
                        <svg class="blocked-icon" viewBox="0 0 16 16" aria-hidden="true">
                            <path
                                d="M8 1.2c1.9 1.7 3 4.1 3 6.4L9.8 8.9H6.2L5 7.6c0-2.3 1.1-4.7 3-6.4zm-3 8.1L3.3 12.7l2.4-1.1-.7-2.3zm6 0 1.7 3.4-2.4-1.1.7-2.3zM7 10.2h2l-1 3.6-1-3.6z"
                                fill="currentColor"
                            />
                        </svg>
                        What should I use instead?
                    </h3>
                    <p class="blocked-card-body">
                        We've built
                        <span class="kiro-badge">
                            <svg class="blocked-icon-sm" viewBox="0 0 16 16" aria-hidden="true">
                                <path d="M9 1L3 9h4l-1 6 6-8H8l1-6z" fill="currentColor" />
                            </svg>
                            Kiro
                        </span>
                        &mdash; an agentic IDE with spec-driven development, hooks, steering files, and all the AI
                        coding features you loved in Q Developer.
                    </p>
                    <p class="blocked-card-body">
                        Kiro includes all the AI coding features from Q Developer, plus spec-driven development and
                        more. Get started free at <a class="blocked-inline-link" :href="kiroUrl">kiro.dev</a>.
                    </p>
                </section>

                <section class="blocked-card blocked-card-tip">
                    <h3 class="blocked-card-title blocked-card-title-tip">
                        <svg class="blocked-icon" viewBox="0 0 16 16" aria-hidden="true">
                            <path
                                d="M8 1.5a4.5 4.5 0 0 0-2.6 8.2v1.1c0 .4.3.7.7.7h3.8c.4 0 .7-.3.7-.7V9.7A4.5 4.5 0 0 0 8 1.5z"
                                fill="currentColor"
                            />
                            <rect x="6.1" y="12.6" width="3.8" height="1.3" rx="0.6" fill="currentColor" />
                        </svg>
                        Already have an account?
                    </h3>
                    <p class="blocked-card-body">
                        If your Builder ID was created <strong>before {{ signupCutoffDate }}</strong
                        >, you can still sign in. Try logging in with your existing credentials &mdash; only newly
                        created accounts are blocked.
                    </p>
                </section>

                <a id="get-started-with-kiro" class="blocked-btn-primary" :href="kiroUrl">
                    &rarr;&nbsp; Get started with Kiro
                </a>
                <button id="go-back" class="blocked-btn-secondary" v-on:click="goBack">
                    Try a different login method
                </button>
                <a id="read-announcement" class="blocked-footer-link" :href="announcementUrl">
                    Read the full announcement
                </a>
            </div>
        </template>

        <template v-else>
            <div class="header">Choose a Q Developer profile</div>
            <div class="subHeader bottomMargin topMargin">
                Your administrator has given you access to Q from multiple profiles. Choose the profile that meets your
                current working needs. You can change your profile at any time.
                <a href="https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/subscribe-understanding-profile.html"
                    >More info.</a
                >
            </div>

            <div class="bottomMargin">
                <!-- TODO: should use profile.arn as item-id but not idx, which will require more work to refactor auth flow code path -->
                <SelectableItem
                    v-for="(profile, idx) in availableRegionProfiles"
                    :key="profile.arn"
                    @toggle="toggleItemSelection"
                    :item-id="idx"
                    :item-title="`${profile.name}`"
                    :item-sub-title="`${profile.region}`"
                    :item-text="`Account: ${profile.description}`"
                    :isSelected="selectedRegionProfileIndex === idx"
                    :class="['selectable-item', { selected: selectedRegionProfileIndex === idx }]"
                ></SelectableItem>
            </div>

            <div v-if="errorMessage" id="error-message" class="bottomMargin">
                We couldn't load your Q Developer profiles. Please try again.
            </div>

            <div>
                <template v-if="errorMessage">
                    <button id="reload" class="continue-button" v-on:click="retryLoadProfiles">Try again</button>
                    <button id="signout" class="topMargin" v-on:click="signout">Sign Out</button>
                </template>
                <template v-else>
                    <button
                        class="continue-button"
                        id="profile-selection-continue-button"
                        v-on:click="onClickContinue()"
                        :disabled="isRetryLoading"
                    >
                        {{ isRetryLoading ? 'Refreshing' : 'Continue' }}
                    </button>
                </template>
            </div>
        </template>
    </div>
</template>
<script lang="ts">
import { PropType, defineComponent } from 'vue'
import { FeatureId, notAcceptingNewCustomersPrefix } from './types'
import { WebviewClientFactory } from '../../../webviews/client'
import { CommonAuthWebview } from './backend'
import SelectableItem from './selectableItem.vue'
import { RegionProfile } from '../../../codewhisperer/models/model'

const client = WebviewClientFactory.create<CommonAuthWebview>()

const FeatureNames: { [key in FeatureId]: string } = {
    AMAZONQ: 'Amazon Q',
    TOOLKIT: 'Toolkit',
} as const
type FeatureName = (typeof FeatureNames)[keyof typeof FeatureNames]

export default defineComponent({
    name: 'RegionProfileSelector',
    components: {
        SelectableItem,
    },
    data() {
        return {
            name: '' as FeatureName,
            errorMessage: '' as String,
            // The dates and URLs are product copy, not derived from the service response. The service
            // message is still stored (it is what marks the identity as blocked) but is no longer
            // displayed: this screen explains the situation and the way forward, which the raw message
            // does not.
            signupCutoffDate: 'May 15, 2026',
            endOfSupportDate: 'April 30, 2027',
            kiroUrl: 'https://kiro.dev',
            announcementUrl: 'https://aws.amazon.com/blogs/devops/amazon-q-developer-end-of-support-announcement/',
            isNotAcceptingNewCustomers: false,
            doShow: false,
            availableRegionProfiles: [] as RegionProfile[],
            selectedRegionProfileIndex: 0,
            isFirstLoading: false,
            isRetryLoading: false,
        }
    },
    props: {
        app: {
            type: String as PropType<FeatureId>,
            required: true,
        },
        state: {
            type: String,
            required: true,
        },
    },
    async created() {
        this.doShow = true
    },
    async mounted() {
        this.firstTimeLoadProfiles()
    },
    methods: {
        toggleItemSelection(itemId: number) {
            this.selectedRegionProfileIndex = itemId
        },
        onClickContinue() {
            if (this.availableRegionProfiles[this.selectedRegionProfileIndex] !== undefined) {
                const selectedProfile = this.availableRegionProfiles[this.selectedRegionProfileIndex]
                client.selectRegionProfile(selectedProfile, 'auth')
            } else {
                // TODO: handle error
            }
        },
        async signout() {
            client.emitUiClick('auth_signout')
            await client.signout()
        },
        /**
         * Amazon Q Developer is no longer accepting new customers for this identity — there is
         * nothing to retry. Clear any lingering connection (if one still exists) so the user
         * lands back on a neutral login screen; must never throw even if the connection was
         * already cleared elsewhere.
         */
        async goBack() {
            client.emitUiClick('auth_go_back_not_accepting_new_customers')
            await client.signOutIfConnected()
        },
        // hack to have 2 different flag because we want to render differently for 2 paths
        async retryLoadProfiles() {
            this.isRetryLoading = true
            await this.listAvailableProfiles()
            this.isRetryLoading = false
        },
        firstTimeLoadProfiles() {
            this.isFirstLoading = true
            this.listAvailableProfiles().then(() => {
                this.isFirstLoading = false
            })
        },
        async listAvailableProfiles() {
            this.errorMessage = ''
            this.isNotAcceptingNewCustomers = false
            const r = await client.listRegionProfiles()
            if (typeof r === 'string') {
                if (r.startsWith(notAcceptingNewCustomersPrefix)) {
                    this.isNotAcceptingNewCustomers = true
                    this.errorMessage = r.slice(notAcceptingNewCustomersPrefix.length)
                } else {
                    this.errorMessage = r
                }
            } else {
                this.availableRegionProfiles = r
                // auto select and bypass this profile view if profile count === 1
                if (this.availableRegionProfiles.length === 1) {
                    await client.selectRegionProfile(this.availableRegionProfiles[0], 'update')
                }
            }
        },
    },
})

/**
 * The ID of the element we will use to determine that the UI has completed its initial load.
 *
 * This makes assumptions that we will be in a certain state of the UI (eg showing a form vs. a loading bar).
 * So if the UI flow changes, this may need to be updated.
 */
export function getReadyElementId() {
    // On every initial load, we ASSUME that the user will always be in the connection selection state,
    // which is why we specifically look for this button.
    return 'profile-selection-continue-button'
}
</script>
<style scoped>
@import './base.css';

/* --- Access-blocked screen -------------------------------------------------------------------
   The surrounding container is capped at 260px for the profile picker, which is too narrow for
   this content, so the blocked screen widens itself rather than changing that shared cap. Colours
   come from VS Code theme variables so the screen follows light and dark themes; only the accent
   hues and the primary button gradient are fixed, since those carry meaning.
   ------------------------------------------------------------------------------------------- */
#blocked-screen {
    width: 90vw;
    max-width: 380px;
    margin: 0 auto;
    text-align: left;
}

.blocked-heading {
    font-size: calc(var(--font-size-base) + 2px);
    font-weight: 700;
    text-align: center;
    color: var(--vscode-foreground);
}

.blocked-subheading {
    margin-top: 4px;
    margin-bottom: 14px;
    text-align: center;
    font-size: var(--font-size-base);
    color: var(--vscode-descriptionForeground);
}

.blocked-card {
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 10px;
    background: var(--vscode-editorWidget-background, transparent);
}

.blocked-card-highlight {
    border-color: #4a6cf7;
}

.blocked-card-tip {
    border-color: #3fb950;
}

.blocked-card-title {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 6px 0;
    font-size: calc(var(--font-size-base) - 1px);
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #f2b100;
}

.blocked-card-title-highlight {
    color: #4a6cf7;
}

.blocked-card-title-tip {
    color: #3fb950;
}

.blocked-icon {
    width: 13px;
    height: 13px;
    flex: 0 0 auto;
}

.blocked-icon-sm {
    width: 10px;
    height: 10px;
}

.blocked-card-body {
    margin: 0 0 6px 0;
    font-size: var(--font-size-base);
    line-height: 1.45;
    color: var(--vscode-foreground);
}

.blocked-card-body:last-child {
    margin-bottom: 0;
}

.kiro-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    border-radius: 10px;
    font-weight: 600;
    color: #4a6cf7;
    background: rgba(74, 108, 247, 0.14);
}

.blocked-inline-link,
.blocked-footer-link {
    color: var(--vscode-textLink-foreground);
    /* The mock renders links without an underline; keep one on hover so they remain discoverable. */
    text-decoration: none;
}

.blocked-inline-link:hover,
.blocked-footer-link:hover {
    text-decoration: underline;
}

.blocked-btn-primary,
.blocked-btn-secondary {
    display: block;
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    margin-top: 8px;
    border-radius: 6px;
    font-size: var(--font-size-base);
    font-weight: 700;
    text-align: center;
    cursor: pointer;
}

.blocked-btn-primary {
    /* Fixed gradient: this is the one element on the screen that should read as a product action
       rather than as IDE chrome. */
    background: linear-gradient(90deg, #4a6cf7 0%, #7a5af8 100%);
    border: none;
    color: #ffffff;
    text-decoration: none;
}

.blocked-btn-secondary {
    background: transparent;
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.5));
    color: var(--vscode-foreground);
    font-weight: 400;
}

.blocked-footer-link {
    display: block;
    margin-top: 12px;
    text-align: center;
    font-size: var(--font-size-base);
}

/* TODO: clean up these CSS entries */
#profile-selector-container {
    height: auto;
    margin: auto;
    position: absolute;
    top: var(--auth-container-top);
    max-width: 260px;
    width: 90vw;
}

.selectable-item {
    margin-bottom: 5px;
    /* margin-top: 10px; */
    cursor: pointer;
    width: 100%;
}

.header {
    font-size: var(--font-size-base);
    font-weight: bold;
}

.vscode-dark .header {
    color: white;
}
.vscode-light .header {
    color: black;
}

.title {
    margin-bottom: 3px;
    margin-top: 3px;
    font-size: var(--font-size-base);
    font-weight: 500;
}
.vscode-dark .title {
    color: white;
}
.vscode-light .title {
    color: black;
}

.subHeader {
    font-size: var(--font-size-sm);
}
.continue-button {
    background-color: var(--vscode-button-background);
    color: white;
    width: 100%;
    height: 30px;
    border: none;
    border-radius: 4px;
    font-weight: bold;
    margin-bottom: 3px;
    margin-top: 3px;
    cursor: pointer;
    font-size: var(--font-size-base);
}

.continue-button:disabled {
    background-color: var(--vscode-input-background);
    color: #6f6f6f;
    cursor: not-allowed;
}

body.vscode-high-contrast:not(body.vscode-high-contrast-light) .continue-button {
    background-color: white;
    color: var(--vscode-input-background);
}

body.vscode-high-contrast:not(body.vscode-high-contrast-light) .continue-button:disabled {
    background-color: #6f6f6f;
    color: var(--vscode-input-background);
}

body.vscode-high-contrast-light .continue-button {
    background-color: var(--vscode-button-background);
    color: white;
}

.bottomMargin {
    margin-bottom: 12px;
}
.topMargin {
    margin-top: 6px;
}

#icon-container {
    display: flex;
    flex-direction: column;
    /* justify-content: center; */
    align-items: center;
}

#error-message {
    text-align: center;
    font-size: var(--font-size-base);
}

button#signout {
    cursor: pointer;
    color: var(--vscode-textLink-foreground);
    border: none;
    background: none;
    user-select: none;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
}
</style>
