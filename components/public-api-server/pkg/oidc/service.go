// Copyright (c) 2022 Gitpod GmbH. All rights reserved.
// Licensed under the GNU Affero General Public License (AGPL).
// See License.AGPL.txt in the project root for license information.

package oidc

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	goidc "github.com/coreos/go-oidc/v3/oidc"
	"github.com/gitpod-io/gitpod/common-go/log"
	db "github.com/gitpod-io/gitpod/components/gitpod-db/go"
	"github.com/gitpod-io/gitpod/public-api-server/pkg/jws"
	"github.com/google/uuid"
	"golang.org/x/oauth2"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"gorm.io/gorm"
)

type Service struct {
	dbConn *gorm.DB
	cipher db.Cipher

	// jwts
	stateExpiry    time.Duration
	signerVerifier jws.SignerVerifier

	sessionServiceAddress string

	// TODO(at) remove by enhancing test setups
	skipVerifyIdToken bool
}

type ClientConfig struct {
	ID             string
	OrganizationID string
	Issuer         string
	OAuth2Config   *oauth2.Config
	VerifierConfig *goidc.Config
}

type StartParams struct {
	State       string
	Nonce       string
	AuthCodeURL string
}

type AuthFlowResult struct {
	IDToken *goidc.IDToken         `json:"idToken"`
	Claims  map[string]interface{} `json:"claims"`
}

func NewService(sessionServiceAddress string, dbConn *gorm.DB, cipher db.Cipher, signerVerifier jws.SignerVerifier, stateExpiry time.Duration) *Service {
	return &Service{
		sessionServiceAddress: sessionServiceAddress,

		dbConn: dbConn,
		cipher: cipher,

		signerVerifier: signerVerifier,
		stateExpiry:    stateExpiry,
	}
}

func (s *Service) GetStartParams(config *ClientConfig, redirectURL string, stateParams StateParams) (*StartParams, error) {
	// the `state` is supposed to be passed through unmodified by the IdP.
	state, err := s.encodeStateParam(stateParams)
	if err != nil {
		return nil, fmt.Errorf("failed to encode state")
	}

	// number used once
	nonce, err := randString(32)
	if err != nil {
		return nil, fmt.Errorf("failed to create nonce")
	}

	// Configuring `AuthCodeOption`s, e.g. nonce
	config.OAuth2Config.RedirectURL = redirectURL
	authCodeURL := config.OAuth2Config.AuthCodeURL(state, goidc.Nonce(nonce))

	return &StartParams{
		AuthCodeURL: authCodeURL,
		State:       state,
		Nonce:       nonce,
	}, nil
}

func (s *Service) encodeStateParam(state StateParams) (string, error) {
	now := time.Now().UTC()
	expiry := now.Add(s.stateExpiry)
	token := NewStateJWT(state, now, expiry)

	signed, err := s.signerVerifier.Sign(token)
	if err != nil {
		return "", fmt.Errorf("failed to sign jwt: %w", err)
	}
	return signed, nil
}

func (s *Service) decodeStateParam(encodedToken string) (StateParams, error) {
	claims := &StateClaims{}
	_, err := s.signerVerifier.Verify(encodedToken, claims)
	if err != nil {
		return StateParams{}, fmt.Errorf("failed to verify state token: %w", err)
	}

	return claims.StateParams, nil
}

func randString(size int) (string, error) {
	b := make([]byte, size)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func (s *Service) GetClientConfigFromStartRequest(r *http.Request) (*ClientConfig, error) {
	orgSlug := r.URL.Query().Get("orgSlug")
	if orgSlug != "" {
		dbEntry, err := db.GetOIDCClientConfigByOrgSlug(r.Context(), s.dbConn, orgSlug)
		if err != nil {
			return nil, fmt.Errorf("Failed to find OIDC clients: %w", err)
		}

		config, err := s.convertClientConfig(r.Context(), dbEntry)
		if err != nil {
			return nil, fmt.Errorf("Failed to find OIDC clients: %w", err)
		}

		return &config, nil
	}

	idParam := r.URL.Query().Get("id")
	if idParam == "" {
		return nil, fmt.Errorf("missing id parameter")
	}

	if idParam != "" {
		config, err := s.getConfigById(r.Context(), idParam)
		if err != nil {
			return nil, err
		}
		return config, nil
	}

	return nil, fmt.Errorf("failed to find OIDC config")
}

func (s *Service) GetClientConfigFromCallbackRequest(r *http.Request) (*ClientConfig, *StateParams, error) {
	stateParam := r.URL.Query().Get("state")
	if stateParam == "" {
		return nil, nil, fmt.Errorf("missing state parameter")
	}

	state, err := s.decodeStateParam(stateParam)
	if err != nil {
		return nil, nil, fmt.Errorf("bad state param")
	}
	config, _ := s.getConfigById(r.Context(), state.ClientConfigID)
	if config != nil {
		return config, &state, nil
	}

	return nil, nil, fmt.Errorf("failed to find OIDC config on callback")
}

func (s *Service) ActivateClientConfig(ctx context.Context, config *ClientConfig) error {
	uuid, err := uuid.Parse(config.ID)
	if err != nil {
		return err
	}
	return db.ActivateClientConfig(ctx, s.dbConn, uuid)
}

func (s *Service) getConfigById(ctx context.Context, id string) (*ClientConfig, error) {
	uuid, err := uuid.Parse(id)
	if err != nil {
		return nil, err
	}
	dbEntry, err := db.GetOIDCClientConfig(ctx, s.dbConn, uuid)
	if err != nil {
		return nil, err
	}
	config, err := s.convertClientConfig(ctx, dbEntry)
	if err != nil {
		log.Log.WithError(err).Error("Failed to decrypt oidc client config.")
		return nil, status.Errorf(codes.Internal, "Failed to decrypt OIDC client config.")
	}

	return &config, nil
}

func (s *Service) convertClientConfig(ctx context.Context, dbEntry db.OIDCClientConfig) (ClientConfig, error) {
	spec, err := dbEntry.Data.Decrypt(s.cipher)
	if err != nil {
		log.Log.WithError(err).Error("Failed to decrypt oidc client config.")
		return ClientConfig{}, status.Errorf(codes.Internal, "Failed to decrypt OIDC client config.")
	}

	provider, err := oidc.NewProvider(ctx, dbEntry.Issuer)
	if err != nil {
		return ClientConfig{}, err
	}

	return ClientConfig{
		ID:             dbEntry.ID.String(),
		OrganizationID: dbEntry.OrganizationID.String(),
		Issuer:         dbEntry.Issuer,
		OAuth2Config: &oauth2.Config{
			ClientID:     spec.ClientID,
			ClientSecret: spec.ClientSecret,
			Endpoint:     provider.Endpoint(),
			Scopes:       spec.Scopes,
		},
		VerifierConfig: &goidc.Config{
			ClientID: spec.ClientID,
		},
	}, nil
}

type AuthenticateParams struct {
	Config           *ClientConfig
	OAuth2Result     *OAuth2Result
	NonceCookieValue string
}

func (s *Service) Authenticate(ctx context.Context, params AuthenticateParams) (*AuthFlowResult, error) {
	rawIDToken, ok := params.OAuth2Result.OAuth2Token.Extra("id_token").(string)
	if !ok {
		return nil, fmt.Errorf("id_token not found")
	}

	provider, err := oidc.NewProvider(ctx, params.Config.Issuer)
	if err != nil {
		return nil, fmt.Errorf("Failed to initialize provider.")
	}
	verifier := provider.Verifier(&goidc.Config{
		ClientID: params.Config.OAuth2Config.ClientID,
	})

	idToken, err := verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return nil, fmt.Errorf("failed to verify id_token: %w", err)
	}
	claims := map[string]interface{}{}
	err = idToken.Claims(&claims)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal the payload of the ID token: %w", err)
	}
	if idToken.Nonce != params.NonceCookieValue {
		return nil, fmt.Errorf("nonce mismatch")
	}
	return &AuthFlowResult{
		IDToken: idToken,
		Claims:  claims,
	}, nil
}

func (s *Service) CreateSession(ctx context.Context, flowResult *AuthFlowResult, organizationId string) (*http.Cookie, error) {
	type CreateSessionPayload struct {
		AuthFlowResult
		OrganizationID string `json:"organizationId"`
	}
	sessionPayload := CreateSessionPayload{
		AuthFlowResult: *flowResult,
		OrganizationID: organizationId,
	}
	payload, err := json.Marshal(sessionPayload)
	if err != nil {
		return nil, err
	}

	url := fmt.Sprintf("http://%s/session", s.sessionServiceAddress)
	res, err := http.Post(url, "application/json", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}

	if res.StatusCode == http.StatusOK {
		cookies := res.Cookies()
		if len(cookies) == 1 {
			return cookies[0], nil
		}
		return nil, fmt.Errorf("unexpected count of cookies: %v", len(cookies))
	}
	message, _ := io.ReadAll(res.Body)
	log.WithField("create-session-error", message).Error("Failed to create session (via server)")
	return nil, fmt.Errorf("unexpected status code: %v", res.StatusCode)
}
