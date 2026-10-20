import { type CanActivate, Injectable } from "@nestjs/common";

/**
 * Ponto de extensão da autenticação. Hoje deixa tudo passar: o desafio
 * não pontua autenticação e pede para não competir com o núcleo financeiro.
 *
 * Desenho previsto (ARCHITECTURE.md): cada provedor é um client do IdP
 * (Keycloak) com client credentials; este guard valida o JWT pelo JWKS do
 * IdP e confere que o claim do client bate com o providerId do payload.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
