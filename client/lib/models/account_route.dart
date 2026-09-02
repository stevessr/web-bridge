enum ChatNetwork { qq, matrix, telegram }

enum RouteMode { server, client }

enum AccountStatus { offline, connecting, online, error }

class AccountRoute {
  const AccountRoute({
    required this.network,
    required this.accountId,
    required this.mode,
    this.displayName,
    this.status = AccountStatus.offline,
    this.lastError,
  }) : assert(
         network != ChatNetwork.qq || mode == RouteMode.server,
         'QQ must use the server',
       );

  factory AccountRoute.fromJson(Map<String, dynamic> json) {
    final account = json['account'] as Map<String, dynamic>;
    return AccountRoute(
      network: ChatNetwork.values.byName(account['network'] as String),
      accountId: account['id'] as String,
      mode: RouteMode.values.byName(json['route'] as String),
      displayName: json['display_name'] as String?,
      status: AccountStatus.values.byName(json['status'] as String),
      lastError: json['last_error'] as String?,
    );
  }

  final ChatNetwork network;
  final String accountId;
  final RouteMode mode;
  final String? displayName;
  final AccountStatus status;
  final String? lastError;

  String get key => '${network.name}:$accountId';
  String get label => displayName?.isNotEmpty == true ? displayName! : accountId;
  bool get canChangeMode => network != ChatNetwork.qq;
}
