# Regras de Segurança SESÉ

Site: https://antoneli1982.github.io/regras_de_seguranca/

Hospedagem no GitHub Pages e dados no Firebase Realtime Database, projeto exclusivo `regras-de-seguranca`, plano Spark. Nenhum serviço pago ou conta de faturamento é necessário. O Firebase Storage não é usado.

Textos, fotos, enquadramento e marcações editáveis são sincronizados automaticamente em `regras_de_seguranca/projeto`. Fotos novas são ajustadas para até 3840 pixels e armazenadas no próprio banco. A barra superior só confirma a sincronização após a gravação. A navegação entre páginas continua independente em cada dispositivo.

No primeiro acesso, se o banco estiver vazio, o backup local existente é importado sem substituir um projeto já criado por outro dispositivo. Os botões Salvar backup e Carregar backup mantêm uma cópia manual neste dispositivo; carregar o backup substitui o projeto compartilhado mediante confirmação. Alterações pendentes são preservadas no IndexedDB para nova tentativa após reabrir. Aguarde “Sincronizado entre dispositivos” antes de fechar para garantir o envio ao banco.

As regras públicas de leitura e gravação, sem autenticação ou expiração, foram escolhidas pelo proprietário. Qualquer pessoa com acesso ao endereço do banco pode ler, modificar ou apagar dados.

Sem custos não significa uso ilimitado: aplicam-se as cotas do Spark. Não fazer upgrade para Blaze se o requisito for zero cobrança. A codificação atual limita cada imagem a 8 Mi caracteres; o banco também impõe seus próprios limites de gravação.

Configuração pública em `firebase-config.js`; sincronização em `cloud-sync.js`. `index_firebase_pronto.html` redireciona para o site principal para não manter uma versão antiga dependente do Storage.

Verificação realizada com dois contextos de navegador independentes: leitura inicial, sincronização bidirecional, persistência após recarregar, edição simultânea de campos diferentes, criação/duplicação/exclusão de páginas, fotos, reconexão e layout de celular.

Testes de regressão da persistência: `node --test tests/cloud-sync.test.cjs`. Usam um banco simulado, sem alterar dados de produção, e cobrem carregamento de foto durante atualização remota, exclusão durante leitura, enquadramento/marcações e recuperação de gravações pendentes.
