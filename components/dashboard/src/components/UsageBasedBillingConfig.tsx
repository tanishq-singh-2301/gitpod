/**
 * Copyright (c) 2022 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License.AGPL.txt in the project root for license information.
 */

import { AttributionId } from "@gitpod/gitpod-protocol/lib/attribution";
import { ErrorCodes } from "@gitpod/gitpod-protocol/lib/messaging/error";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";
import { Link } from "react-router-dom";
import DropDown from "../components/DropDown";
import Modal from "../components/Modal";
import { useCurrentOrg } from "../data/organizations/orgs-query";
import { ReactComponent as Spinner } from "../icons/Spinner.svg";
import { ReactComponent as Check } from "../images/check-circle.svg";
import { useCurrency } from "../payment-context";
import { getGitpodService } from "../service/service";
import Alert from "./Alert";
import { Heading2, Subheading } from "./typography/headings";
import { useStripeAppearance } from "./billing/use-stripe-appearance";
import { useStripePromise } from "./billing/use-stripe-promise";
import { AddPaymentMethodModal } from "./billing/AddPaymentMethodModal";
import { Button } from "./Button";
import { useCreateHoldPaymentIntentMutation } from "../data/billing/create-hold-payment-intent-mutation";
import { useToast } from "./toasts/Toasts";
import { useFeatureFlag } from "../data/featureflag-query";

const BASE_USAGE_LIMIT_FOR_STRIPE_USERS = 1000;

interface Props {
    attributionId?: string;
    hideSubheading?: boolean;
}

// Guard against multiple calls to subscripe (per page load)
let didAlreadyCallSubscribe = false;

export default function UsageBasedBillingConfig({ attributionId, hideSubheading = false }: Props) {
    const currentOrg = useCurrentOrg().data;
    const attrId = attributionId ? AttributionId.parse(attributionId) : undefined;
    const [showUpdateLimitModal, setShowUpdateLimitModal] = useState<boolean>(false);
    const [showBillingSetupModal, setShowBillingSetupModal] = useState<boolean>(false);
    const [stripeSubscriptionId, setStripeSubscriptionId] = useState<string | undefined>();
    const [isLoadingStripeSubscription, setIsLoadingStripeSubscription] = useState<boolean>(true);
    const [currentUsage, setCurrentUsage] = useState<number>(0);
    const [usageLimit, setUsageLimit] = useState<number>(0);
    const [stripePortalUrl, setStripePortalUrl] = useState<string | undefined>();
    const [errorMessage, setErrorMessage] = useState<string | undefined>();
    const [priceInformation, setPriceInformation] = useState<string | undefined>();
    const [isCreatingSubscription, setIsCreatingSubscription] = useState(false);
    const paymentVerificationFlow = useFeatureFlag("paymentVerificationFlow");
    const createPaymentIntent = useCreateHoldPaymentIntentMutation();
    const [showAddPaymentMethodModal, setShowAddPaymentMethodModal] = useState<boolean>(false);
    const { toast } = useToast();

    // Stripe-controlled parameters
    const location = useLocation();

    const now = useMemo(() => dayjs().utc(true), []);
    const [billingCycleFrom, setBillingCycleFrom] = useState<dayjs.Dayjs>(now.startOf("month"));
    const [billingCycleTo, setBillingCycleTo] = useState<dayjs.Dayjs>(now.endOf("month"));
    useEffect(() => {
        if (attributionId) {
            getGitpodService().server.getPriceInformation(attributionId).then(setPriceInformation);
        }
    }, [attributionId]);

    const refreshSubscriptionDetails = useCallback(
        async (attributionId: string) => {
            setStripeSubscriptionId(undefined);
            setIsLoadingStripeSubscription(true);
            try {
                getGitpodService().server.getStripePortalUrl(attributionId).then(setStripePortalUrl);
                getGitpodService().server.getUsageBalance(attributionId).then(setCurrentUsage);
                const costCenter = await getGitpodService().server.getCostCenter(attributionId);
                setUsageLimit(costCenter?.spendingLimit || 0);
                setBillingCycleFrom(dayjs(costCenter?.billingCycleStart || now.startOf("month")).utc(true));
                setBillingCycleTo(dayjs(costCenter?.nextBillingTime || now.endOf("month")).utc(true));
                const subscriptionId = await getGitpodService().server.findStripeSubscriptionId(attributionId);
                setStripeSubscriptionId(subscriptionId);
                return subscriptionId;
            } catch (error) {
                console.error("Could not get Stripe subscription details.", error);
                setErrorMessage(`Could not get Stripe subscription details. ${error?.message || String(error)}`);
            } finally {
                setIsLoadingStripeSubscription(false);
            }
        },
        [now],
    );

    useEffect(() => {
        if (!attributionId) {
            return;
        }
        refreshSubscriptionDetails(attributionId);
    }, [attributionId, refreshSubscriptionDetails]);

    const handleAddPaymentMethod = useCallback(async () => {
        if (!attributionId) {
            return;
        }

        try {
            createPaymentIntent.mutateAsync(attributionId);
            setShowAddPaymentMethodModal(true);
        } catch (e) {
            console.error(e);
            toast(e.message || "Oh no, there was a problem with your payment service.");
        }
    }, [attributionId, createPaymentIntent, toast]);

    // Handle stripe setup-intent or payment-intent redirect flow
    useEffect(() => {
        const params = new URLSearchParams(location.search);
        const setupIntentId = params.get("setup_intent");
        const paymentIntentId = params.get("payment_intent");
        const redirectStatus = params.get("redirect_status");
        if ((setupIntentId || paymentIntentId) && redirectStatus) {
            subscribeToStripe({
                setupIntentId: setupIntentId || undefined,
                paymentIntentId: paymentIntentId || undefined,
                redirectStatus,
            });
        }
        // We only want to run this effect once on page load as we're handling a stripe redirect flow
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // TODO: put this in a useMutation()
    const subscribeToStripe = useCallback(
        async (stripeParams: { setupIntentId?: string; paymentIntentId?: string; redirectStatus: string }) => {
            if (!attributionId) {
                return;
            }
            const { setupIntentId, paymentIntentId, redirectStatus } = stripeParams;

            // Should be at least one intent id
            if (!setupIntentId && !paymentIntentId) {
                return;
            }

            if (redirectStatus !== "succeeded") {
                // TODO(gpl) We have to handle external validation errors (3DS, e.g.) here
                return;
            }

            // Guard against multiple execution following the pattern here: https://react.dev/learn/you-might-not-need-an-effect#initializing-the-application
            if (didAlreadyCallSubscribe) {
                console.log("didAlreadyCallSubscribe, skipping this time.");
                return;
            }
            didAlreadyCallSubscribe = true;
            console.log("didAlreadyCallSubscribe false, first run.");

            // Remove the query params from the URL
            window.history.replaceState({}, "", location.pathname);

            try {
                setIsCreatingSubscription(true);
                // Pick a good initial value for the Stripe usage limit (base_limit * team_size)
                // FIXME: Should we ask the customer to confirm or edit this default limit?
                let limit = BASE_USAGE_LIMIT_FOR_STRIPE_USERS;
                if (attrId?.kind === "team" && currentOrg) {
                    limit = BASE_USAGE_LIMIT_FOR_STRIPE_USERS * currentOrg.members.length;
                }
                const newLimit = await getGitpodService().server.subscribeToStripe(
                    attributionId,
                    setupIntentId || "",
                    paymentIntentId || "",
                    limit,
                );
                if (newLimit) {
                    setUsageLimit(newLimit);
                }

                // TODO: should change this to setTimeouts, reschedule at end of check, and wrap it in a Promise,
                // otherwise we can queue up many pending requests if they take longer than 1 second
                //refresh every second until we get a subscriptionId
                const interval = setInterval(async () => {
                    try {
                        const subscriptionId = await refreshSubscriptionDetails(attributionId);
                        if (subscriptionId) {
                            setIsCreatingSubscription(false);
                            clearInterval(interval);
                        }
                    } catch (error) {
                        console.error(error);
                    }
                }, 1000);
            } catch (error) {
                console.error("Could not subscribe to Stripe", error);
                setIsCreatingSubscription(false);
                setErrorMessage(
                    `Could not subscribe: ${
                        error?.message || String(error)
                    } Contact support@gitpod.io if you believe this is a system error.`,
                );
            }
        },
        [attrId?.kind, attributionId, currentOrg, location.pathname, refreshSubscriptionDetails],
    );

    const showSpinner = !attributionId || isLoadingStripeSubscription || isCreatingSubscription;
    const showBalance = !showSpinner;
    const showUpgradeTeam =
        !showSpinner && AttributionId.parse(attributionId)?.kind === "team" && !stripeSubscriptionId;
    const showUpgradeUser =
        !showSpinner && AttributionId.parse(attributionId)?.kind === "user" && !stripeSubscriptionId;
    const showManageBilling = !showSpinner && !!stripeSubscriptionId;

    const updateUsageLimit = useCallback(
        async (newLimit: number) => {
            if (!attributionId) {
                return;
            }
            setShowUpdateLimitModal(false);
            try {
                await getGitpodService().server.setUsageLimit(attributionId, newLimit);
                setUsageLimit(newLimit);
            } catch (error) {
                console.error("Failed to update usage limit", error);
                setErrorMessage(`Failed to update usage limit. ${error?.message || String(error)}`);
            }
        },
        [attributionId],
    );

    const balance = currentUsage * -1 + usageLimit;
    const percentage = usageLimit === 0 ? 0 : Math.max(Math.round((balance * 100) / usageLimit), 0);
    const freePlanName = useMemo(() => {
        if (usageLimit === 0) {
            return "No Plan";
        }
        return usageLimit > 500 ? "Open Source" : "Free";
    }, [usageLimit]);

    return (
        <div className="mb-16">
            {!hideSubheading && (
                <Subheading>
                    {attributionId && AttributionId.parse(attributionId)?.kind === "user"
                        ? "Manage billing for your personal account."
                        : "Manage billing for your organization."}
                </Subheading>
            )}
            <div className="max-w-xl flex flex-col">
                {errorMessage && (
                    <Alert className="max-w-xl mt-2" closable={false} showIcon={true} type="error">
                        {errorMessage}
                    </Alert>
                )}
                {showSpinner && (
                    <div className="flex flex-col mt-4 h-52 p-4 rounded-xl bg-gray-50 dark:bg-gray-800">
                        <div className="uppercase text-sm text-gray-400 dark:text-gray-500">Balance</div>
                        <Spinner className="m-2 animate-spin" />
                    </div>
                )}
                {showBalance && (
                    <div className="flex flex-col mt-4 p-4 rounded-xl bg-gray-50 dark:bg-gray-800">
                        <div className="uppercase text-sm text-gray-400 dark:text-gray-500">Balance</div>
                        <div className="mt-1 text-xl font-semibold flex-grow">
                            <span className="text-gray-900 dark:text-gray-100">
                                {balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </span>
                            <span className="text-gray-400 dark:text-gray-500"> Credits</span>
                        </div>
                        <div className="mt-4 text-sm flex text-gray-400 dark:text-gray-500">
                            <span className="flex-grow">
                                {typeof currentUsage === "number" &&
                                    typeof usageLimit === "number" &&
                                    usageLimit > 0 && <span>{percentage}% remaining</span>}
                            </span>
                            <span>Monthly limit: {usageLimit} Credits</span>
                            {showManageBilling && (
                                <>
                                    <span>&nbsp;&middot;&nbsp;</span>
                                    <span className="gp-link" onClick={() => setShowUpdateLimitModal(true)}>
                                        Update limit
                                    </span>
                                </>
                            )}
                        </div>
                        <div className="mt-2 flex">
                            <progress className="h-2 flex-grow rounded-xl" value={percentage} max={100} />
                        </div>
                        <div className="bg-gray-100 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 -m-4 p-4 mt-4 rounded-b-xl flex">
                            <div className="flex-grow">
                                <div className="uppercase text-sm text-gray-400 dark:text-gray-500">Current Period</div>
                                <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
                                    <span title={billingCycleFrom.toDate().toUTCString().replace("GMT", "UTC")}>
                                        {billingCycleFrom.format("MMM D, YYYY")}
                                    </span>{" "}
                                    &ndash;{" "}
                                    <span title={billingCycleTo.toDate().toUTCString().replace("GMT", "UTC")}>
                                        {billingCycleTo.format("MMM D, YYYY")}
                                    </span>
                                </div>
                            </div>
                            <div>
                                <Link
                                    to={`/usage?org=${
                                        attrId?.kind === "team" ? attrId.teamId : "0"
                                    }#${billingCycleFrom.format("YYYY-MM-DD")}:${billingCycleTo.format("YYYY-MM-DD")}`}
                                >
                                    <button className="secondary">View Usage →</button>
                                </Link>
                            </div>
                        </div>
                    </div>
                )}
                {(showUpgradeTeam || showUpgradeUser) && (
                    <>
                        <div className="flex flex-col mt-4 p-4 rounded-t-xl bg-gray-50 dark:bg-gray-800">
                            <div className="uppercase text-sm text-gray-400 dark:text-gray-500">Current Plan</div>
                            <div className="mt-1 text-xl font-semibold flex-grow text-gray-600 dark:text-gray-400">
                                {freePlanName}
                            </div>
                            <div className="mt-4 flex space-x-1 text-gray-400 dark:text-gray-500">
                                <div className="m-0.5 w-5 h-5 text-orange-500">
                                    <Check />
                                </div>
                                <div className="flex flex-col w-96">
                                    <span className="font-bold text-gray-500 dark:text-gray-400">
                                        {usageLimit} credits
                                    </span>
                                    <span>{usageLimit / 10} hours of Standard workspace usage.</span>
                                </div>
                            </div>
                        </div>
                        <div className="flex flex-col p-4 rounded-b-xl bg-gray-100 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
                            <div className="uppercase text-sm text-gray-400 dark:text-gray-500">Upgrade Plan</div>
                            <div className="mt-1 text-xl font-semibold flex-grow text-gray-800 dark:text-gray-100">
                                Pay-as-you-go
                            </div>
                            <div className="mt-4 flex space-x-1 text-gray-400 dark:text-gray-500">
                                <div className="m-0.5 w-8 h-5">
                                    <Check />
                                </div>
                                <div className="flex flex-col">
                                    <span>
                                        {priceInformation}{" "}
                                        <a className="gp-link" href="https://www.gitpod.io/pricing#cost-estimator">
                                            Estimate costs
                                        </a>
                                    </span>
                                </div>
                            </div>
                            <div className="flex justify-end mt-6 space-x-2">
                                {stripePortalUrl && (
                                    <a href={stripePortalUrl}>
                                        <button className="secondary" disabled={!stripePortalUrl}>
                                            View Past Invoices ↗
                                        </button>
                                    </a>
                                )}
                                <Button
                                    loading={createPaymentIntent.isLoading}
                                    onClick={() =>
                                        paymentVerificationFlow
                                            ? handleAddPaymentMethod()
                                            : setShowBillingSetupModal(true)
                                    }
                                >
                                    Upgrade Plan
                                </Button>
                            </div>
                        </div>
                    </>
                )}
                {showManageBilling && (
                    <div className="max-w-xl flex space-x-4">
                        <div className="flex-grow flex flex-col mt-4 p-4 rounded-xl bg-gray-50 dark:bg-gray-800">
                            <div className="uppercase text-sm text-gray-400 dark:text-gray-500">Current Plan</div>
                            <div className="mt-1 text-xl font-semibold flex-grow text-gray-800 dark:text-gray-100">
                                Pay-as-you-go
                            </div>
                            <div className="mt-4 flex space-x-1 text-gray-400 dark:text-gray-500">
                                <Check className="m-0.5 w-8 h-5 text-orange-500" />
                                <div className="flex flex-col">
                                    <span>
                                        {priceInformation}{" "}
                                        <a className="gp-link" href="https://www.gitpod.io/pricing#cost-estimator">
                                            Estimate costs
                                        </a>
                                    </span>
                                </div>
                            </div>

                            <a className="mt-5 self-end" href={stripePortalUrl}>
                                <button className="secondary" disabled={!stripePortalUrl}>
                                    Manage Plan ↗
                                </button>
                            </a>
                        </div>
                    </div>
                )}
            </div>
            {!!attributionId && showBillingSetupModal && (
                <BillingSetupModal attributionId={attributionId} onClose={() => setShowBillingSetupModal(false)} />
            )}
            {attributionId && createPaymentIntent.data && showAddPaymentMethodModal && (
                <AddPaymentMethodModal
                    attributionId={attributionId}
                    clientSecret={createPaymentIntent.data.paymentIntentClientSecret}
                    onClose={() => setShowAddPaymentMethodModal(false)}
                />
            )}
            {showUpdateLimitModal && (
                <UpdateLimitModal
                    minValue={
                        AttributionId.parse(attributionId || "")?.kind === "user"
                            ? BASE_USAGE_LIMIT_FOR_STRIPE_USERS
                            : 0
                    }
                    currentValue={usageLimit}
                    onClose={() => setShowUpdateLimitModal(false)}
                    onUpdate={(newLimit) => updateUsageLimit(newLimit)}
                />
            )}
        </div>
    );
}

export function BillingSetupModal(props: { attributionId: string; onClose: () => void }) {
    const appearance = useStripeAppearance();
    const { stripePromise } = useStripePromise();
    const [stripeSetupIntentClientSecret, setStripeSetupIntentClientSecret] = useState<string | undefined>();

    useEffect(() => {
        const { server } = getGitpodService();
        Promise.all([
            server.getStripeSetupIntentClientSecret().then((v) => () => setStripeSetupIntentClientSecret(v)),
        ]).then((setters) => setters.forEach((s) => s()));
    }, []);

    return (
        <Modal visible={true} onClose={props.onClose}>
            <Heading2 className="flex">Upgrade Plan</Heading2>
            <div className="border-t border-gray-200 dark:border-gray-700 mt-4 pt-2 -mx-6 px-6 flex flex-col">
                {(!stripePromise || !stripeSetupIntentClientSecret) && (
                    <div className="h-80 flex items-center justify-center">
                        <Spinner className="h-5 w-5 animate-spin" />
                    </div>
                )}
                {!!stripePromise && !!stripeSetupIntentClientSecret && (
                    <Elements
                        stripe={stripePromise}
                        options={{
                            appearance,
                            clientSecret: stripeSetupIntentClientSecret,
                        }}
                    >
                        <CreditCardInputForm attributionId={props.attributionId} />
                    </Elements>
                )}
            </div>
        </Modal>
    );
}

function CreditCardInputForm(props: { attributionId: string }) {
    const stripe = useStripe();
    const elements = useElements();
    const { currency, setCurrency } = useCurrency();
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [errorMessage, setErrorMessage] = useState<string | undefined>();

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        const attrId = AttributionId.parse(props.attributionId);
        if (!stripe || !elements || !attrId) {
            return;
        }
        setErrorMessage(undefined);
        setIsLoading(true);
        try {
            // Create Stripe customer with currency
            await getGitpodService().server.createStripeCustomerIfNeeded(props.attributionId, currency);
            const result = await stripe.confirmSetup({
                elements,
                confirmParams: {
                    return_url: window.location.href,
                },
            });
            if (result.error) {
                // Show error to your customer (for example, payment details incomplete)
                throw result.error;
            } else {
                // Your customer will be redirected to your `return_url`. For some payment
                // methods like iDEAL, your customer will be redirected to an intermediate
                // site first to authorize the payment, then redirected to the `return_url`.
            }
        } catch (error) {
            console.error("Failed to submit form.", error);
            let message = `Failed to submit form. ${error?.message || String(error)}`;
            if (error && error.code === ErrorCodes.SUBSCRIPTION_ERROR) {
                message =
                    error.data?.hint === "currency"
                        ? error.message
                        : "Failed to subscribe. Please contact support@gitpod.io";
            }
            setErrorMessage(message);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <form className="mt-4 flex-grow flex flex-col" onSubmit={handleSubmit}>
            {errorMessage && (
                <Alert className="mb-4" closable={false} showIcon={true} type="error">
                    {errorMessage}
                </Alert>
            )}
            <PaymentElement />
            <div className="mt-4 flex-grow flex justify-end items-end">
                <div className="flex-grow flex space-x-1">
                    <span>Currency:</span>
                    <DropDown
                        customClasses="w-32"
                        renderAsLink={true}
                        activeEntry={currency}
                        entries={[
                            {
                                title: "EUR",
                                onClick: () => setCurrency("EUR"),
                            },
                            {
                                title: "USD",
                                onClick: () => setCurrency("USD"),
                            },
                        ]}
                    />
                </div>
                <button className="my-0 flex items-center space-x-2" disabled={!stripe || isLoading}>
                    <span>Add Payment Method</span>
                    {isLoading && <Spinner className="h-5 w-5 animate-spin filter brightness-150" />}
                </button>
            </div>
        </form>
    );
}

function UpdateLimitModal(props: {
    minValue?: number;
    currentValue: number | undefined;
    onClose: () => void;
    onUpdate: (newLimit: number) => {};
}) {
    const [errorMessage, setErrorMessage] = useState<string>("");
    const [newLimit, setNewLimit] = useState<string | undefined>(
        typeof props.currentValue === "number" ? String(props.currentValue) : undefined,
    );

    function onSubmit(event: React.FormEvent) {
        event.preventDefault();
        if (!newLimit) {
            setErrorMessage("Please specify a limit");
            return;
        }
        const n = parseInt(newLimit, 10);
        if (typeof n !== "number") {
            setErrorMessage("Please specify a limit that is a valid number");
            return;
        }
        if (typeof props.minValue === "number" && n < props.minValue) {
            setErrorMessage(`Please specify a limit that is >= ${props.minValue}`);
            return;
        }
        props.onUpdate(n);
    }

    return (
        <Modal visible={true} onClose={props.onClose} onEnter={() => false}>
            <Heading2 className="mb-4">Usage Limit</Heading2>
            <form onSubmit={onSubmit}>
                <div className="border-t border-b border-gray-200 dark:border-gray-700 -mx-6 px-6 py-4 flex flex-col">
                    <p className="pb-4 text-gray-500 text-base">Set usage limit in total credits per month.</p>
                    {errorMessage && (
                        <Alert type="error" className="-mt-2 mb-2">
                            {errorMessage}
                        </Alert>
                    )}
                    <label className="font-medium">
                        Credits
                        <div className="w-full">
                            <input
                                type="text"
                                value={newLimit}
                                className={`rounded-md w-full truncate overflow-x-scroll pr-8 ${
                                    errorMessage ? "error" : ""
                                }`}
                                onChange={(e) => {
                                    setErrorMessage("");
                                    setNewLimit(e.target.value);
                                }}
                            />
                        </div>
                    </label>
                </div>
                <div className="flex justify-end mt-6 space-x-2">
                    <button className="secondary">Update</button>
                </div>
            </form>
        </Modal>
    );
}
