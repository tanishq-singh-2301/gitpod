/**
 * Copyright (c) 2020 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License.AGPL.txt in the project root for license information.
 */

import * as http from "http";
import * as express from "express";
import * as ws from "ws";
import * as bodyParser from "body-parser";
import * as cookieParser from "cookie-parser";
import { injectable, inject } from "inversify";
import * as prom from "prom-client";
import { SessionHandlerProvider } from "./session-handler";
import { Authenticator } from "./auth/authenticator";
import { UserController } from "./user/user-controller";
import { EventEmitter } from "events";
import { toIWebSocket } from "@gitpod/gitpod-protocol/lib/messaging/node/connection";
import { WsExpressHandler, WsRequestHandler } from "./express/ws-handler";
import { isAllowedWebsocketDomain, bottomErrorHandler, unhandledToError } from "./express-util";
import { createWebSocketConnection } from "vscode-ws-jsonrpc/lib";
import { MessageBusIntegration } from "./workspace/messagebus-integration";
import { log } from "@gitpod/gitpod-protocol/lib/util/logging";
import { AddressInfo } from "net";
import { ConsensusLeaderQorum } from "./consensus/consensus-leader-quorum";
import { RabbitMQConsensusLeaderMessenger } from "./consensus/rabbitmq-consensus-leader-messenger";
import { WorkspaceGarbageCollector } from "./workspace/garbage-collector";
import { WorkspaceDownloadService } from "./workspace/workspace-download-service";
import { MonitoringEndpointsApp } from "./monitoring-endpoints";
import { WebsocketConnectionManager } from "./websocket/websocket-connection-manager";
import { PeriodicDbDeleter, TypeORM } from "@gitpod/gitpod-db/lib";
import { OneTimeSecretServer } from "./one-time-secret-server";
import { Disposable, DisposableCollection, GitpodClient, GitpodServer } from "@gitpod/gitpod-protocol";
import { BearerAuth, isBearerAuthError } from "./auth/bearer-authenticator";
import { HostContextProvider } from "./auth/host-context-provider";
import { CodeSyncService } from "./code-sync/code-sync-service";
import { increaseHttpRequestCounter, observeHttpRequestDuration, setGitpodVersion } from "./prometheus-metrics";
import { OAuthController } from "./oauth-server/oauth-controller";
import {
    HeadlessLogController,
    HEADLESS_LOGS_PATH_PREFIX,
    HEADLESS_LOG_DOWNLOAD_PATH_PREFIX,
} from "./workspace/headless-log-controller";
import { NewsletterSubscriptionController } from "./user/newsletter-subscription-controller";
import { Config } from "./config";
import { DebugApp } from "@gitpod/gitpod-protocol/lib/util/debug-app";
import { LocalMessageBroker } from "./messaging/local-message-broker";
import { WsConnectionHandler } from "./express/ws-connection-handler";
import { InstallationAdminController } from "./installation-admin/installation-admin-controller";
import { WebhookEventGarbageCollector } from "./projects/webhook-event-garbage-collector";
import { LivenessController } from "./liveness/liveness-controller";
import { IamSessionApp } from "./iam/iam-session-app";
import { LongRunningMigrationService } from "@gitpod/gitpod-db/lib/long-running-migration/long-running-migration";
import { API } from "./api/server";
import { SnapshotService } from "./workspace/snapshot-service";
import { GithubApp } from "./prebuilds/github-app";
import { GitLabApp } from "./prebuilds/gitlab-app";
import { BitbucketApp } from "./prebuilds/bitbucket-app";
import { BitbucketServerApp } from "./prebuilds/bitbucket-server-app";
import { GitHubEnterpriseApp } from "./prebuilds/github-enterprise-app";
import { repeat } from "@gitpod/gitpod-protocol/lib/util/repeat";
import { ResourceLockedError } from "redlock";
import { RedisMutex } from "./redis/mutex";

@injectable()
export class Server<C extends GitpodClient, S extends GitpodServer> {
    static readonly EVENT_ON_START = "start";

    @inject(Config) protected readonly config: Config;
    @inject(TypeORM) protected readonly typeOrm: TypeORM;
    @inject(SessionHandlerProvider) protected sessionHandlerProvider: SessionHandlerProvider;
    @inject(Authenticator) protected authenticator: Authenticator;
    @inject(UserController) protected readonly userController: UserController;
    @inject(InstallationAdminController) protected readonly installationAdminController: InstallationAdminController;
    @inject(WebsocketConnectionManager) protected websocketConnectionHandler: WebsocketConnectionManager;
    @inject(MessageBusIntegration) protected readonly messagebus: MessageBusIntegration;
    @inject(LocalMessageBroker) protected readonly localMessageBroker: LocalMessageBroker;
    @inject(WorkspaceDownloadService) protected readonly workspaceDownloadService: WorkspaceDownloadService;
    @inject(LivenessController) protected readonly livenessController: LivenessController;
    @inject(MonitoringEndpointsApp) protected readonly monitoringEndpointsApp: MonitoringEndpointsApp;
    @inject(CodeSyncService) private readonly codeSyncService: CodeSyncService;
    @inject(HeadlessLogController) protected readonly headlessLogController: HeadlessLogController;
    @inject(DebugApp) protected readonly debugApp: DebugApp;

    @inject(GithubApp) protected readonly githubApp: GithubApp;
    @inject(GitLabApp) protected readonly gitLabApp: GitLabApp;
    @inject(BitbucketApp) protected readonly bitbucketApp: BitbucketApp;
    @inject(BitbucketServerApp) protected readonly bitbucketServerApp: BitbucketServerApp;
    @inject(GitHubEnterpriseApp) protected readonly gitHubEnterpriseApp: GitHubEnterpriseApp;

    @inject(RabbitMQConsensusLeaderMessenger) protected readonly consensusMessenger: RabbitMQConsensusLeaderMessenger;
    @inject(ConsensusLeaderQorum) protected readonly qorum: ConsensusLeaderQorum;
    @inject(WorkspaceGarbageCollector) protected readonly workspaceGC: WorkspaceGarbageCollector;
    @inject(OneTimeSecretServer) protected readonly oneTimeSecretServer: OneTimeSecretServer;
    @inject(PeriodicDbDeleter) protected readonly periodicDbDeleter: PeriodicDbDeleter;
    @inject(WebhookEventGarbageCollector) protected readonly webhookEventGarbageCollector: WebhookEventGarbageCollector;
    @inject(LongRunningMigrationService) protected readonly migrationService: LongRunningMigrationService;
    @inject(SnapshotService) protected readonly snapshotService: SnapshotService;

    @inject(BearerAuth) protected readonly bearerAuth: BearerAuth;

    @inject(RedisMutex) protected readonly mutex: RedisMutex;

    @inject(HostContextProvider) protected readonly hostCtxProvider: HostContextProvider;
    @inject(OAuthController) protected readonly oauthController: OAuthController;
    @inject(NewsletterSubscriptionController)
    protected readonly newsletterSubscriptionController: NewsletterSubscriptionController;

    @inject(IamSessionApp) protected readonly iamSessionAppCreator: IamSessionApp;
    protected iamSessionApp?: express.Application;
    protected iamSessionAppServer?: http.Server;

    @inject(API) protected readonly api: API;
    protected apiServer?: http.Server;

    protected readonly eventEmitter = new EventEmitter();
    protected app?: express.Application;
    protected httpServer?: http.Server;
    protected monitoringApp?: express.Application;
    protected installationAdminApp?: express.Application;
    protected monitoringHttpServer?: http.Server;
    protected installationAdminHttpServer?: http.Server;
    protected disposables = new DisposableCollection();

    public async init(app: express.Application) {
        log.setVersion(this.config.version);
        log.info("server initializing...");

        // Set version info metric
        setGitpodVersion(this.config.version);

        // ensure DB connection is established to avoid noisy error messages
        await this.typeOrm.connect();
        log.info("connected to DB");

        // metrics
        app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
            const startTime = Date.now();
            req.on("end", () => {
                const method = req.method;
                const route = req.route?.path || req.baseUrl || "unknown";
                observeHttpRequestDuration(method, route, res.statusCode, (Date.now() - startTime) / 1000);
                increaseHttpRequestCounter(method, route, res.statusCode);
            });

            return next();
        });

        // Express configuration
        // Read bodies as JSON (but keep the raw body just in case)
        app.use(
            bodyParser.json({
                verify: (req, res, buffer) => {
                    (req as any).rawBody = buffer;
                },
            }),
        );
        app.use(bodyParser.urlencoded({ extended: true }));
        // Add cookie Parser
        app.use(cookieParser());
        app.set("trust proxy", 1); // trust first proxy

        // Install Sessionhandler
        app.use(this.sessionHandlerProvider.sessionHandler);

        // Install passport
        await this.authenticator.init(app);

        // Ensure that host contexts of dynamic auth providers are initialized.
        await this.hostCtxProvider.init();

        // Websocket for client connection
        const websocketConnectionHandler = this.websocketConnectionHandler;
        this.eventEmitter.on(Server.EVENT_ON_START, (httpServer) => {
            // CSRF protection: check "Origin" header:
            //  - for cookie/session AND Bearer auth: MUST be hostUrl.hostname (gitpod.io)
            //  - edge case: empty "Origin" is always permitted
            // We rely on the origin header being set correctly (needed by regular clients to use Gitpod:
            // CORS allows subdomains to access gitpod.io)
            const verifyOrigin = (origin: string) => {
                let allowedRequest = isAllowedWebsocketDomain(origin, this.config.hostUrl.url.hostname);
                if (!allowedRequest && this.config.insecureNoDomain) {
                    log.warn("Websocket connection CSRF guard disabled");
                    allowedRequest = true;
                }
                return allowedRequest;
            };

            /**
             * Verify the web socket handshake request.
             */
            const verifyClient: ws.VerifyClientCallbackAsync = async (info, callback) => {
                let authenticatedUsingBearerToken = false;
                if (info.req.url === "/v1") {
                    // Connection attempt with Bearer-Token: be less strict for now
                    if (!verifyOrigin(info.origin)) {
                        log.debug("Websocket connection attempt with non-matching Origin header.", {
                            origin: info.origin,
                        });
                        return callback(false, 403);
                    }

                    try {
                        await this.bearerAuth.auth(info.req as express.Request);
                        authenticatedUsingBearerToken = true;
                    } catch (e) {
                        if (isBearerAuthError(e)) {
                            return callback(false, 401, e.message);
                        }
                        log.warn("authentication failed: ", e);
                        return callback(false, 500);
                    }
                    // intentional fall-through to cookie/session based authentication
                }

                if (!authenticatedUsingBearerToken) {
                    // Connection attempt with cookie/session based authentication: be strict about where we accept connections from!
                    if (!verifyOrigin(info.origin)) {
                        log.debug("Websocket connection attempt with non-matching Origin header: " + info.origin);
                        return callback(false, 403);
                    }
                }

                return callback(true);
            };

            // Materialize session into req.session
            const handleSession: WsRequestHandler = (ws, req, next) => {
                // The fake response needs to be create in a per-request context to avoid memory leaks
                this.sessionHandlerProvider.sessionHandler(req, {} as express.Response, next);
            };

            // Materialize user into req.user
            const initSessionHandlers = this.authenticator.initHandlers.map<WsRequestHandler>(
                (handler) => (ws, req, next) => {
                    // The fake response needs to be create in a per-request context to avoid memory leaks
                    handler(req, {} as express.Response, next);
                },
            );

            const wsPingPongHandler = new WsConnectionHandler();
            const wsHandler = new WsExpressHandler(httpServer, verifyClient);
            wsHandler.ws(
                websocketConnectionHandler.path,
                (ws, request) => {
                    const websocket = toIWebSocket(ws);
                    (request as any).wsConnection = createWebSocketConnection(websocket, console);
                },
                handleSession,
                ...initSessionHandlers,
                wsPingPongHandler.handler(),
                (ws: ws, req: express.Request) => {
                    websocketConnectionHandler.onConnection((req as any).wsConnection, req);
                },
            );
            wsHandler.ws(
                "/v1",
                (ws, request) => {
                    const websocket = toIWebSocket(ws);
                    (request as any).wsConnection = createWebSocketConnection(websocket, console);
                },
                wsPingPongHandler.handler(),
                (ws: ws, req: express.Request) => {
                    websocketConnectionHandler.onConnection((req as any).wsConnection, req);
                },
            );
            wsHandler.ws(/.*/, (ws, request) => {
                // fallthrough case
                // note: this is suboptimal as we upgrade and than terminate the request. But we're not sure this is a problem at all, so we start out with this
                log.warn("websocket path not matching", { path: request.path });
                ws.terminate();
            });

            // start ws heartbeat/ping-pong
            wsPingPongHandler.start();
            this.disposables.push(wsPingPongHandler);
        });

        // register routers
        await this.registerRoutes(app);

        // Turn unhandled requests into errors
        app.use(unhandledToError);

        // Generic error handler
        app.use(bottomErrorHandler(log.debug));

        // Health check + metrics endpoints
        this.monitoringApp = this.monitoringEndpointsApp.create();

        // Installation Admin - host separately to avoid exposing publicly
        this.installationAdminApp = this.installationAdminController.create();

        // IAM Session App - host separately to avoid exposing publicly
        this.iamSessionApp = this.iamSessionAppCreator.create();

        // Report current websocket connections
        this.installWebsocketConnectionGauge();
        this.installWebsocketClientContextGauge();

        // Connect to message bus
        await this.messagebus.connect();

        // Start local message broker
        await this.localMessageBroker.start();
        this.disposables.push(Disposable.create(() => this.localMessageBroker.stop().catch(log.error)));

        // Start concensus quorum
        await this.consensusMessenger.connect();
        await this.qorum.start();

        // Start workspace garbage collector
        this.workspaceGC.start().catch((err) => log.error("wsgc: error during startup", err));

        // Start one-time secret GC
        this.oneTimeSecretServer.startPruningExpiredSecrets();

        // Start DB updater
        this.startDbDeleter().catch((err) => log.error("starting DB deleter", err));

        // Start long running migrations
        this.startLongRunningMigrations().catch((err) => log.error("long running migrations errored", err));

        // Start WebhookEvent GC
        this.webhookEventGarbageCollector
            .start()
            .catch((err) => log.error("webhook-event-gc: error during startup", err));

        if (!this.config.completeSnapshotJob?.disabled) {
            // Start Snapshot Service
            log.info("Starting snapshot completion job...");
            await this.snapshotService.start();
        }

        this.app = app;

        log.info("server initialized.");
    }

    protected async startLongRunningMigrations(): Promise<void> {
        if (this.config.longRunningMigrationsJob?.disabled) {
            return;
        }
        log.info("Starting long running migrations job...");
        let completed = false;
        while (!completed) {
            if (await this.qorum.areWeLeader()) {
                completed = await this.migrationService.runMigrationBatch();
            }
            // sleep 5min
            await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));
        }
    }

    protected async startDbDeleter() {
        if (!this.config.runDbDeleter) {
            return;
        }

        const intervalMs = 30 * 1000;
        repeat(async () => {
            try {
                await this.mutex.using(["database-deleter"], intervalMs, async (signal) => {
                    try {
                        await this.periodicDbDeleter.runOnce();
                    } catch (err) {
                        log.error("[PeriodicDbDeleter] error during run", err);
                    }
                });
            } catch (err) {
                if (err instanceof ResourceLockedError) {
                    log.debug(
                        "[PeriodicDbDeleter] failed to acquire database-deleter lock, another instance already has the lock",
                        err,
                    );
                    return;
                }

                log.error("[PeriodicDbDeleter] failed to acquire database-deleter lock", err);
            }
        }, intervalMs); // deletion is never time-critical, so we should ensure we do not spam ourselves
    }

    protected async registerRoutes(app: express.Application) {
        app.use(this.userController.apiRouter);
        app.use(this.oneTimeSecretServer.apiRouter);
        app.use("/workspace-download", this.workspaceDownloadService.apiRouter);
        app.use("/code-sync", this.codeSyncService.apiRouter);
        app.use(HEADLESS_LOGS_PATH_PREFIX, this.headlessLogController.headlessLogs);
        app.use(HEADLESS_LOG_DOWNLOAD_PATH_PREFIX, this.headlessLogController.headlessLogDownload);
        app.use("/live", this.livenessController.apiRouter);
        app.use(this.newsletterSubscriptionController.apiRouter);
        app.use("/version", (req: express.Request, res: express.Response, next: express.NextFunction) => {
            res.send(this.config.version);
        });
        app.use(this.oauthController.oauthRouter);

        if (this.config.githubApp?.enabled && this.githubApp.server) {
            log.info("Registered GitHub app at /apps/github");
            app.use("/apps/github/", this.githubApp.server?.expressApp);
            log.debug(`GitHub app ready under ${this.githubApp.server.expressApp.path()}`);
        } else {
            log.info("GitHub app disabled");
        }

        log.info("Registered GitLab app at " + GitLabApp.path);
        app.use(GitLabApp.path, this.gitLabApp.router);

        log.info("Registered Bitbucket app at " + BitbucketApp.path);
        app.use(BitbucketApp.path, this.bitbucketApp.router);

        log.info("Registered GitHub EnterpriseApp app at " + GitHubEnterpriseApp.path);
        app.use(GitHubEnterpriseApp.path, this.gitHubEnterpriseApp.router);

        log.info("Registered Bitbucket Server app at " + BitbucketServerApp.path);
        app.use(BitbucketServerApp.path, this.bitbucketServerApp.router);
    }

    public async start(port: number) {
        if (!this.app) {
            throw new Error("server cannot start, not initialized");
        }

        const httpServer = this.app.listen(port, () => {
            this.eventEmitter.emit(Server.EVENT_ON_START, httpServer);
            log.info(`server listening on port: ${(<AddressInfo>httpServer.address()).port}`);
        });
        this.httpServer = httpServer;

        if (this.monitoringApp) {
            this.monitoringHttpServer = this.monitoringApp.listen(9500, "localhost", () => {
                log.info(
                    `monitoring app listening on port: ${(<AddressInfo>this.monitoringHttpServer!.address()).port}`,
                );
            });
        }

        if (this.installationAdminApp) {
            this.installationAdminHttpServer = this.installationAdminApp.listen(9000, () => {
                log.info(
                    `installation admin app listening on port: ${
                        (<AddressInfo>this.installationAdminHttpServer!.address()).port
                    }`,
                );
            });
        }

        if (this.iamSessionApp) {
            this.iamSessionAppServer = this.iamSessionApp.listen(9876, () => {
                log.info(
                    `IAM session server listening on port: ${(<AddressInfo>this.iamSessionAppServer!.address()).port}`,
                );
            });
        }

        this.apiServer = this.api.listen(9877);

        this.debugApp.start();
    }

    public async stop() {
        await this.debugApp.stop();
        await this.stopServer(this.iamSessionAppServer);
        await this.stopServer(this.monitoringHttpServer);
        await this.stopServer(this.installationAdminHttpServer);
        await this.stopServer(this.httpServer);
        await this.stopServer(this.apiServer);
        this.disposables.dispose();
        log.info("server stopped.");
    }

    protected async stopServer(server?: http.Server): Promise<void> {
        if (!server) {
            return;
        }
        return new Promise((resolve) =>
            server.close((err: any) => {
                if (err) {
                    log.warn(`error on server close.`, { err });
                }
                resolve();
            }),
        );
    }

    protected installWebsocketConnectionGauge() {
        const gauge = new prom.Gauge({
            name: `server_websocket_connection_count`,
            help: "Currently served websocket connections",
            labelNames: ["clientType"],
        });
        this.websocketConnectionHandler.onConnectionCreated((s, _) =>
            gauge.inc({ clientType: s.clientMetadata.type || "undefined" }),
        );
        this.websocketConnectionHandler.onConnectionClosed((s, _) =>
            gauge.dec({ clientType: s.clientMetadata.type || "undefined" }),
        );
    }

    protected installWebsocketClientContextGauge() {
        const gauge = new prom.Gauge({
            name: `server_websocket_client_context_count`,
            help: "Currently served client contexts",
            labelNames: ["authLevel"],
        });
        this.websocketConnectionHandler.onClientContextCreated((ctx) =>
            gauge.inc({ authLevel: ctx.clientMetadata.authLevel }),
        );
        this.websocketConnectionHandler.onClientContextClosed((ctx) =>
            gauge.dec({ authLevel: ctx.clientMetadata.authLevel }),
        );
    }
}
