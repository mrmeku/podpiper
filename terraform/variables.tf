variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zero Trust permissions"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for mrmeku.com"
  type        = string
}

variable "google_client_id" {
  description = "Google OAuth 2.0 Client ID (created manually in Google Cloud Console)"
  type        = string
}

variable "google_client_secret" {
  description = "Google OAuth 2.0 Client Secret"
  type        = string
  sensitive   = true
}

variable "tunnel_hostname" {
  description = "Public hostname for the Temporal UI"
  type        = string
  default     = "podpiper.mrmeku.com"
}

variable "allowed_emails" {
  description = "Email addresses allowed to access the Temporal UI"
  type        = list(string)
  default     = ["mrmeku@gmail.com", "achew@achew.com"]
}
