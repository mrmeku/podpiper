output "tunnel_token" {
  description = "Cloudflare tunnel token for cloudflared (use in CLOUDFLARE_TUNNEL_TOKEN env var)"
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.podpiper.token
  sensitive   = true
}

output "tunnel_id" {
  description = "Cloudflare tunnel ID"
  value       = cloudflare_zero_trust_tunnel_cloudflared.podpiper.id
}
