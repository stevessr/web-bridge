enum ChatNetwork { qq, matrix, telegram }
enum RouteMode { server, client }

class AccountRoute {
  const AccountRoute({required this.network, required this.mode})
      : assert(network != ChatNetwork.qq || mode == RouteMode.server, 'QQ must use the server');

  final ChatNetwork network;
  final RouteMode mode;

  bool get canChangeMode => network != ChatNetwork.qq;
}
