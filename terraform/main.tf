provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

resource "random_id" "tunnel_secret" {
  byte_length = 32
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "podpiper" {
  account_id    = var.cloudflare_account_id
  name          = "podpiper"
  config_src    = "cloudflare"
  tunnel_secret = random_id.tunnel_secret.b64_std
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "podpiper" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.podpiper.id
  config = {
    ingress = [
      {
        hostname = var.tunnel_hostname
        service  = "http://temporal-ui:8080"
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

resource "cloudflare_zero_trust_access_identity_provider" "google" {
  account_id = var.cloudflare_account_id
  name       = "Google"
  type       = "google"
  config = {
    client_id     = var.google_client_id
    client_secret = var.google_client_secret
  }
}

resource "cloudflare_zero_trust_access_application" "temporal_ui" {
  account_id                = var.cloudflare_account_id
  name                      = "Temporal UI"
  domain                    = var.tunnel_hostname
  type                      = "self_hosted"
  session_duration          = "24h"
  allowed_idps              = [cloudflare_zero_trust_access_identity_provider.google.id]
  auto_redirect_to_identity = true
  policies = [
    {
      name     = "Allowed Users"
      decision = "allow"
      include  = [for email in var.allowed_emails : { email = { email = email } }]
    },
  ]
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "podpiper" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.podpiper.id
}
