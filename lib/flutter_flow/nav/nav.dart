import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '/backend/backend.dart';

import '/auth/base_auth_user_provider.dart';

import '/flutter_flow/flutter_flow_theme.dart';
import '/flutter_flow/flutter_flow_util.dart';

import '/index.dart';

export 'package:go_router/go_router.dart';
export 'serialization_util.dart';

const kTransitionInfoKey = '__transition_info__';

GlobalKey<NavigatorState> appNavigatorKey = GlobalKey<NavigatorState>();

class AppStateNotifier extends ChangeNotifier {
  AppStateNotifier._();

  static AppStateNotifier? _instance;
  static AppStateNotifier get instance => _instance ??= AppStateNotifier._();

  BaseAuthUser? initialUser;
  BaseAuthUser? user;
  bool showSplashImage = true;
  String? _redirectLocation;

  /// Determines whether the app will refresh and build again when a sign
  /// in or sign out happens. This is useful when the app is launched or
  /// on an unexpected logout. However, this must be turned off when we
  /// intend to sign in/out and then navigate or perform any actions after.
  /// Otherwise, this will trigger a refresh and interrupt the action(s).
  bool notifyOnAuthChange = true;

  bool get loading => user == null || showSplashImage;
  bool get loggedIn => user?.loggedIn ?? false;
  bool get initiallyLoggedIn => initialUser?.loggedIn ?? false;
  bool get shouldRedirect => loggedIn && _redirectLocation != null;

  String getRedirectLocation() => _redirectLocation!;
  bool hasRedirect() => _redirectLocation != null;
  void setRedirectLocationIfUnset(String loc) => _redirectLocation ??= loc;
  void clearRedirectLocation() => _redirectLocation = null;

  /// Mark as not needing to notify on a sign in / out when we intend
  /// to perform subsequent actions (such as navigation) afterwards.
  void updateNotifyOnAuthChange(bool notify) => notifyOnAuthChange = notify;

  void update(BaseAuthUser newUser) {
    final shouldUpdate =
        user?.uid == null || newUser.uid == null || user?.uid != newUser.uid;
    initialUser ??= newUser;
    user = newUser;
    // Refresh the app on auth change unless explicitly marked otherwise.
    // No need to update unless the user has changed.
    if (notifyOnAuthChange && shouldUpdate) {
      notifyListeners();
    }
    // Once again mark the notifier as needing to update on auth change
    // (in order to catch sign in / out events).
    updateNotifyOnAuthChange(true);
  }

  void stopShowingSplashImage() {
    showSplashImage = false;
    notifyListeners();
  }
}

GoRouter createRouter(AppStateNotifier appStateNotifier, [Widget? entryPage]) =>
    GoRouter(
      initialLocation: '/',
      debugLogDiagnostics: true,
      refreshListenable: appStateNotifier,
      navigatorKey: appNavigatorKey,
      errorBuilder: (context, state) => appStateNotifier.loggedIn
          ? entryPage ?? HomeWidget()
          : SignInWidget(),
      routes: [
        FFRoute(
          name: '_initialize',
          path: '/',
          builder: (context, _) => appStateNotifier.loggedIn
              ? entryPage ?? HomeWidget()
              : SignInWidget(),
        ),
        FFRoute(
          name: HomeWidget.routeName,
          path: HomeWidget.routePath,
          builder: (context, params) => HomeWidget(),
        ),
        FFRoute(
          name: AccountWidget.routeName,
          path: AccountWidget.routePath,
          builder: (context, params) => AccountWidget(),
        ),
        FFRoute(
          name: RouterWidget.routeName,
          path: RouterWidget.routePath,
          builder: (context, params) => RouterWidget(),
        ),
        FFRoute(
          name: OnboardingWidget.routeName,
          path: OnboardingWidget.routePath,
          builder: (context, params) => OnboardingWidget(),
        ),
        FFRoute(
          name: AccomodationsWidget.routeName,
          path: AccomodationsWidget.routePath,
          builder: (context, params) => AccomodationsWidget(),
        ),
        FFRoute(
          name: AboutWidget.routeName,
          path: AboutWidget.routePath,
          builder: (context, params) => AboutWidget(),
        ),
        FFRoute(
          name: TosWidget.routeName,
          path: TosWidget.routePath,
          builder: (context, params) => TosWidget(),
        ),
        FFRoute(
          name: PrivacyPolicyWidget.routeName,
          path: PrivacyPolicyWidget.routePath,
          builder: (context, params) => PrivacyPolicyWidget(),
        ),
        FFRoute(
          name: SearchWidget.routeName,
          path: SearchWidget.routePath,
          builder: (context, params) => SearchWidget(),
        ),
        FFRoute(
          name: SignInWidget.routeName,
          path: SignInWidget.routePath,
          builder: (context, params) => SignInWidget(),
        ),
        FFRoute(
          name: LanguagesWidget.routeName,
          path: LanguagesWidget.routePath,
          builder: (context, params) => LanguagesWidget(),
        ),
        FFRoute(
          name: UpdateUserDataWidget.routeName,
          path: UpdateUserDataWidget.routePath,
          builder: (context, params) => UpdateUserDataWidget(),
        ),
        FFRoute(
          name: LocationSearchWidget.routeName,
          path: LocationSearchWidget.routePath,
          builder: (context, params) => LocationSearchWidget(),
        ),
        FFRoute(
          name: LocationMapWidget.routeName,
          path: LocationMapWidget.routePath,
          builder: (context, params) => LocationMapWidget(
            currentPlace: params.getParam(
              'currentPlace',
              ParamType.FFPlace,
            ),
          ),
        ),
        FFRoute(
          name: LocationPlacesMapWidget.routeName,
          path: LocationPlacesMapWidget.routePath,
          builder: (context, params) => LocationPlacesMapWidget(),
        ),
        FFRoute(
          name: BookingServiceSelectionWidget.routeName,
          path: BookingServiceSelectionWidget.routePath,
          asyncParams: {
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
            'operator': getDoc(['workers'], WorkersRecord.fromSnapshot),
          },
          builder: (context, params) => BookingServiceSelectionWidget(
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
            currentReservation: params.getParam(
              'currentReservation',
              ParamType.int,
            ),
            date: params.getParam(
              'date',
              ParamType.DateTime,
            ),
            time: params.getParam(
              'time',
              ParamType.String,
            ),
            operator: params.getParam(
              'operator',
              ParamType.Document,
            ),
            serviceCategoryReference: params.getParam(
              'serviceCategoryReference',
              ParamType.DocumentReference,
              isList: false,
              collectionNamePath: ['serviceCategories'],
            ),
            isFromSecondAgenda: params.getParam(
              'isFromSecondAgenda',
              ParamType.bool,
            ),
            serviceName: params.getParam(
              'serviceName',
              ParamType.String,
            ),
          ),
        ),
        FFRoute(
          name: BookingOperatorsSelectionWidget.routeName,
          path: BookingOperatorsSelectionWidget.routePath,
          asyncParams: {
            'service': getDoc(['accomodationServices'],
                AccomodationServicesRecord.fromSnapshot),
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
            'appointments':
                getDocList(['appointments'], AppointmentsRecord.fromSnapshot),
            'operator': getDoc(['workers'], WorkersRecord.fromSnapshot),
          },
          builder: (context, params) => BookingOperatorsSelectionWidget(
            service: params.getParam(
              'service',
              ParamType.Document,
            ),
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
            currentReservation: params.getParam(
              'currentReservation',
              ParamType.int,
            ),
            appointments: params.getParam<AppointmentsRecord>(
              'appointments',
              ParamType.Document,
              isList: true,
            ),
            date: params.getParam(
              'date',
              ParamType.DateTime,
            ),
            time: params.getParam(
              'time',
              ParamType.String,
            ),
            operator: params.getParam(
              'operator',
              ParamType.Document,
            ),
          ),
        ),
        FFRoute(
          name: BookingDateSelectionWidget.routeName,
          path: BookingDateSelectionWidget.routePath,
          asyncParams: {
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
            'worker': getDoc(['workers'], WorkersRecord.fromSnapshot),
            'service': getDoc(['accomodationServices'],
                AccomodationServicesRecord.fromSnapshot),
            'appointments':
                getDocList(['appointments'], AppointmentsRecord.fromSnapshot),
          },
          builder: (context, params) => BookingDateSelectionWidget(
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
            worker: params.getParam(
              'worker',
              ParamType.Document,
            ),
            service: params.getParam(
              'service',
              ParamType.Document,
            ),
            currentReservation: params.getParam(
              'currentReservation',
              ParamType.int,
            ),
            appointments: params.getParam<AppointmentsRecord>(
              'appointments',
              ParamType.Document,
              isList: true,
            ),
            date: params.getParam(
              'date',
              ParamType.DateTime,
            ),
            time: params.getParam(
              'time',
              ParamType.String,
            ),
            isFromSecondAgenda: params.getParam(
              'isFromSecondAgenda',
              ParamType.bool,
            ),
            serviceName: params.getParam(
              'serviceName',
              ParamType.String,
            ),
          ),
        ),
        FFRoute(
          name: BookingConfirmWidget.routeName,
          path: BookingConfirmWidget.routePath,
          asyncParams: {
            'appointment':
                getDoc(['appointments'], AppointmentsRecord.fromSnapshot),
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
          },
          builder: (context, params) => BookingConfirmWidget(
            appointment: params.getParam(
              'appointment',
              ParamType.Document,
            ),
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
          ),
        ),
        FFRoute(
          name: BookingsAgendaWidget.routeName,
          path: BookingsAgendaWidget.routePath,
          builder: (context, params) => BookingsAgendaWidget(),
        ),
        FFRoute(
          name: ClientsOldWidget.routeName,
          path: ClientsOldWidget.routePath,
          builder: (context, params) => ClientsOldWidget(),
        ),
        FFRoute(
          name: ClientsWidget.routeName,
          path: ClientsWidget.routePath,
          builder: (context, params) => ClientsWidget(),
        ),
        FFRoute(
          name: BookingClientSelectionWidget.routeName,
          path: BookingClientSelectionWidget.routePath,
          asyncParams: {
            'operator': getDoc(['workers'], WorkersRecord.fromSnapshot),
          },
          builder: (context, params) => BookingClientSelectionWidget(
            date: params.getParam(
              'date',
              ParamType.DateTime,
            ),
            time: params.getParam(
              'time',
              ParamType.String,
            ),
            operator: params.getParam(
              'operator',
              ParamType.Document,
            ),
            serviceCategoryReference: params.getParam(
              'serviceCategoryReference',
              ParamType.DocumentReference,
              isList: false,
              collectionNamePath: ['serviceCategories'],
            ),
            isFromSecondAgenda: params.getParam(
              'isFromSecondAgenda',
              ParamType.bool,
            ),
            serviceName: params.getParam(
              'serviceName',
              ParamType.String,
            ),
          ),
        ),
        FFRoute(
          name: ClientDetailsWidget.routeName,
          path: ClientDetailsWidget.routePath,
          asyncParams: {
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
          },
          builder: (context, params) => ClientDetailsWidget(
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
          ),
        ),
        FFRoute(
          name: ClientPaymentsWidget.routeName,
          path: ClientPaymentsWidget.routePath,
          asyncParams: {
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
          },
          builder: (context, params) => ClientPaymentsWidget(
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
          ),
        ),
        FFRoute(
          name: ClientBookingsWidget.routeName,
          path: ClientBookingsWidget.routePath,
          asyncParams: {
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
          },
          builder: (context, params) => ClientBookingsWidget(
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
          ),
        ),
        FFRoute(
          name: ClientCreateWidget.routeName,
          path: ClientCreateWidget.routePath,
          builder: (context, params) => ClientCreateWidget(),
        ),
        FFRoute(
          name: BookingsListWidget.routeName,
          path: BookingsListWidget.routePath,
          builder: (context, params) => BookingsListWidget(
            startTime: params.getParam(
              'startTime',
              ParamType.DateTime,
            ),
          ),
        ),
        FFRoute(
          name: BookingDetailsWidget.routeName,
          path: BookingDetailsWidget.routePath,
          asyncParams: {
            'appointment':
                getDoc(['appointments'], AppointmentsRecord.fromSnapshot),
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
          },
          builder: (context, params) => BookingDetailsWidget(
            appointment: params.getParam(
              'appointment',
              ParamType.Document,
            ),
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
          ),
        ),
        FFRoute(
          name: PaymentCreateWidget.routeName,
          path: PaymentCreateWidget.routePath,
          asyncParams: {
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
          },
          builder: (context, params) => PaymentCreateWidget(
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
          ),
        ),
        FFRoute(
          name: PaymentConfirmWidget.routeName,
          path: PaymentConfirmWidget.routePath,
          asyncParams: {
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
            'payment': getDoc(['payments'], PaymentsRecord.fromSnapshot),
          },
          builder: (context, params) => PaymentConfirmWidget(
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
            payment: params.getParam(
              'payment',
              ParamType.Document,
            ),
          ),
        ),
        FFRoute(
          name: ClientEditWidget.routeName,
          path: ClientEditWidget.routePath,
          asyncParams: {
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
          },
          builder: (context, params) => ClientEditWidget(
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
          ),
        ),
        FFRoute(
          name: BookingCancelWidget.routeName,
          path: BookingCancelWidget.routePath,
          asyncParams: {
            'appointment':
                getDoc(['appointments'], AppointmentsRecord.fromSnapshot),
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
          },
          builder: (context, params) => BookingCancelWidget(
            appointment: params.getParam(
              'appointment',
              ParamType.Document,
            ),
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
          ),
        ),
        FFRoute(
          name: ClientSalesWidget.routeName,
          path: ClientSalesWidget.routePath,
          asyncParams: {
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
          },
          builder: (context, params) => ClientSalesWidget(
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
          ),
        ),
        FFRoute(
          name: SaleDetailsWidget.routeName,
          path: SaleDetailsWidget.routePath,
          asyncParams: {
            'sale': getDoc(['sales'], SalesRecord.fromSnapshot),
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
          },
          builder: (context, params) => SaleDetailsWidget(
            sale: params.getParam(
              'sale',
              ParamType.Document,
            ),
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
          ),
        ),
        FFRoute(
          name: SaleConfirmWidget.routeName,
          path: SaleConfirmWidget.routePath,
          asyncParams: {
            'sale': getDoc(['sales'], SalesRecord.fromSnapshot),
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
          },
          builder: (context, params) => SaleConfirmWidget(
            sale: params.getParam(
              'sale',
              ParamType.Document,
            ),
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
          ),
        ),
        FFRoute(
          name: BookingRescheduleOperatorsSelectionWidget.routeName,
          path: BookingRescheduleOperatorsSelectionWidget.routePath,
          asyncParams: {
            'service': getDoc(['accomodationServices'],
                AccomodationServicesRecord.fromSnapshot),
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
            'appointment':
                getDoc(['appointments'], AppointmentsRecord.fromSnapshot),
          },
          builder: (context, params) =>
              BookingRescheduleOperatorsSelectionWidget(
            service: params.getParam(
              'service',
              ParamType.Document,
            ),
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
            appointment: params.getParam(
              'appointment',
              ParamType.Document,
            ),
          ),
        ),
        FFRoute(
          name: BookingRescheduleDateSelectionWidget.routeName,
          path: BookingRescheduleDateSelectionWidget.routePath,
          asyncParams: {
            'client': getDoc(['clients'], ClientsRecord.fromSnapshot),
            'worker': getDoc(['workers'], WorkersRecord.fromSnapshot),
            'service': getDoc(['accomodationServices'],
                AccomodationServicesRecord.fromSnapshot),
            'appointment':
                getDoc(['appointments'], AppointmentsRecord.fromSnapshot),
          },
          builder: (context, params) => BookingRescheduleDateSelectionWidget(
            client: params.getParam(
              'client',
              ParamType.Document,
            ),
            worker: params.getParam(
              'worker',
              ParamType.Document,
            ),
            service: params.getParam(
              'service',
              ParamType.Document,
            ),
            appointment: params.getParam(
              'appointment',
              ParamType.Document,
            ),
          ),
        ),
        FFRoute(
          name: HelpWidget.routeName,
          path: HelpWidget.routePath,
          builder: (context, params) => HelpWidget(),
        ),
        FFRoute(
          name: TestWidget.routeName,
          path: TestWidget.routePath,
          builder: (context, params) => TestWidget(),
        ),
        FFRoute(
          name: TrainingWidget.routeName,
          path: TrainingWidget.routePath,
          builder: (context, params) => TrainingWidget(),
        ),
        FFRoute(
          name: TrainingPlayerWidget.routeName,
          path: TrainingPlayerWidget.routePath,
          asyncParams: {
            'data':
                getDoc(['training_videos'], TrainingVideosRecord.fromSnapshot),
          },
          builder: (context, params) => TrainingPlayerWidget(
            data: params.getParam(
              'data',
              ParamType.Document,
            ),
          ),
        ),
        FFRoute(
          name: SecondBookingsAgendaWidget.routeName,
          path: SecondBookingsAgendaWidget.routePath,
          builder: (context, params) => SecondBookingsAgendaWidget(),
        ),
        FFRoute(
          name: SecondBookingsListWidget.routeName,
          path: SecondBookingsListWidget.routePath,
          builder: (context, params) => SecondBookingsListWidget(
            startDate: params.getParam(
              'startDate',
              ParamType.DateTime,
            ),
          ),
        )
      ].map((r) => r.toRoute(appStateNotifier)).toList(),
      observers: [routeObserver],
    );

extension NavParamExtensions on Map<String, String?> {
  Map<String, String> get withoutNulls => Map.fromEntries(
        entries
            .where((e) => e.value != null)
            .map((e) => MapEntry(e.key, e.value!)),
      );
}

extension NavigationExtensions on BuildContext {
  void goNamedAuth(
    String name,
    bool mounted, {
    Map<String, String> pathParameters = const <String, String>{},
    Map<String, String> queryParameters = const <String, String>{},
    Object? extra,
    bool ignoreRedirect = false,
  }) =>
      !mounted || GoRouter.of(this).shouldRedirect(ignoreRedirect)
          ? null
          : goNamed(
              name,
              pathParameters: pathParameters,
              queryParameters: queryParameters,
              extra: extra,
            );

  void pushNamedAuth(
    String name,
    bool mounted, {
    Map<String, String> pathParameters = const <String, String>{},
    Map<String, String> queryParameters = const <String, String>{},
    Object? extra,
    bool ignoreRedirect = false,
  }) =>
      !mounted || GoRouter.of(this).shouldRedirect(ignoreRedirect)
          ? null
          : pushNamed(
              name,
              pathParameters: pathParameters,
              queryParameters: queryParameters,
              extra: extra,
            );

  void safePop() {
    // If there is only one route on the stack, navigate to the initial
    // page instead of popping.
    if (canPop()) {
      pop();
    } else {
      go('/');
    }
  }
}

extension GoRouterExtensions on GoRouter {
  AppStateNotifier get appState => AppStateNotifier.instance;
  void prepareAuthEvent([bool ignoreRedirect = false]) =>
      appState.hasRedirect() && !ignoreRedirect
          ? null
          : appState.updateNotifyOnAuthChange(false);
  bool shouldRedirect(bool ignoreRedirect) =>
      !ignoreRedirect && appState.hasRedirect();
  void clearRedirectLocation() => appState.clearRedirectLocation();
  void setRedirectLocationIfUnset(String location) =>
      appState.updateNotifyOnAuthChange(false);
}

extension _GoRouterStateExtensions on GoRouterState {
  Map<String, dynamic> get extraMap =>
      extra != null ? extra as Map<String, dynamic> : {};
  Map<String, dynamic> get allParams => <String, dynamic>{}
    ..addAll(pathParameters)
    ..addAll(uri.queryParameters)
    ..addAll(extraMap);
  TransitionInfo get transitionInfo => extraMap.containsKey(kTransitionInfoKey)
      ? extraMap[kTransitionInfoKey] as TransitionInfo
      : TransitionInfo.appDefault();
}

class FFParameters {
  FFParameters(this.state, [this.asyncParams = const {}]);

  final GoRouterState state;
  final Map<String, Future<dynamic> Function(String)> asyncParams;

  Map<String, dynamic> futureParamValues = {};

  // Parameters are empty if the params map is empty or if the only parameter
  // present is the special extra parameter reserved for the transition info.
  bool get isEmpty =>
      state.allParams.isEmpty ||
      (state.allParams.length == 1 &&
          state.extraMap.containsKey(kTransitionInfoKey));
  bool isAsyncParam(MapEntry<String, dynamic> param) =>
      asyncParams.containsKey(param.key) && param.value is String;
  bool get hasFutures => state.allParams.entries.any(isAsyncParam);
  Future<bool> completeFutures() => Future.wait(
        state.allParams.entries.where(isAsyncParam).map(
          (param) async {
            final doc = await asyncParams[param.key]!(param.value)
                .onError((_, __) => null);
            if (doc != null) {
              futureParamValues[param.key] = doc;
              return true;
            }
            return false;
          },
        ),
      ).onError((_, __) => [false]).then((v) => v.every((e) => e));

  dynamic getParam<T>(
    String paramName,
    ParamType type, {
    bool isList = false,
    List<String>? collectionNamePath,
    StructBuilder<T>? structBuilder,
  }) {
    if (futureParamValues.containsKey(paramName)) {
      return futureParamValues[paramName];
    }
    if (!state.allParams.containsKey(paramName)) {
      return null;
    }
    final param = state.allParams[paramName];
    // Got parameter from `extras`, so just directly return it.
    if (param is! String) {
      return param;
    }
    // Return serialized value.
    return deserializeParam<T>(
      param,
      type,
      isList,
      collectionNamePath: collectionNamePath,
      structBuilder: structBuilder,
    );
  }
}

class FFRoute {
  const FFRoute({
    required this.name,
    required this.path,
    required this.builder,
    this.requireAuth = false,
    this.asyncParams = const {},
    this.routes = const [],
  });

  final String name;
  final String path;
  final bool requireAuth;
  final Map<String, Future<dynamic> Function(String)> asyncParams;
  final Widget Function(BuildContext, FFParameters) builder;
  final List<GoRoute> routes;

  GoRoute toRoute(AppStateNotifier appStateNotifier) => GoRoute(
        name: name,
        path: path,
        redirect: (context, state) {
          if (appStateNotifier.shouldRedirect) {
            final redirectLocation = appStateNotifier.getRedirectLocation();
            appStateNotifier.clearRedirectLocation();
            return redirectLocation;
          }

          if (requireAuth && !appStateNotifier.loggedIn) {
            appStateNotifier.setRedirectLocationIfUnset(state.uri.toString());
            return '/signIn';
          }
          return null;
        },
        pageBuilder: (context, state) {
          fixStatusBarOniOS16AndBelow(context);
          final ffParams = FFParameters(state, asyncParams);
          final page = ffParams.hasFutures
              ? FutureBuilder(
                  future: ffParams.completeFutures(),
                  builder: (context, _) => builder(context, ffParams),
                )
              : builder(context, ffParams);
          final child = appStateNotifier.loading
              ? Container(
                  color: FlutterFlowTheme.of(context).primary,
                  child: Center(
                    child: Image.asset(
                      'assets/images/logo_(1)_1.png',
                      width: 144.0,
                      fit: BoxFit.cover,
                    ),
                  ),
                )
              : page;

          final transitionInfo = state.transitionInfo;
          return transitionInfo.hasTransition
              ? CustomTransitionPage(
                  key: state.pageKey,
                  child: child,
                  transitionDuration: transitionInfo.duration,
                  transitionsBuilder:
                      (context, animation, secondaryAnimation, child) =>
                          PageTransition(
                    type: transitionInfo.transitionType,
                    duration: transitionInfo.duration,
                    reverseDuration: transitionInfo.duration,
                    alignment: transitionInfo.alignment,
                    child: child,
                  ).buildTransitions(
                    context,
                    animation,
                    secondaryAnimation,
                    child,
                  ),
                )
              : MaterialPage(key: state.pageKey, child: child);
        },
        routes: routes,
      );
}

class TransitionInfo {
  const TransitionInfo({
    required this.hasTransition,
    this.transitionType = PageTransitionType.fade,
    this.duration = const Duration(milliseconds: 300),
    this.alignment,
  });

  final bool hasTransition;
  final PageTransitionType transitionType;
  final Duration duration;
  final Alignment? alignment;

  static TransitionInfo appDefault() => TransitionInfo(
        hasTransition: true,
        transitionType: PageTransitionType.fade,
        duration: Duration(milliseconds: 300),
      );
}

class RootPageContext {
  const RootPageContext(this.isRootPage, [this.errorRoute]);
  final bool isRootPage;
  final String? errorRoute;

  static bool isInactiveRootPage(BuildContext context) {
    final rootPageContext = context.read<RootPageContext?>();
    final isRootPage = rootPageContext?.isRootPage ?? false;
    final location = GoRouterState.of(context).uri.toString();
    return isRootPage &&
        location != '/' &&
        location != rootPageContext?.errorRoute;
  }

  static Widget wrap(Widget child, {String? errorRoute}) => Provider.value(
        value: RootPageContext(true, errorRoute),
        child: child,
      );
}

extension GoRouterLocationExtension on GoRouter {
  String getCurrentLocation() {
    final RouteMatch lastMatch = routerDelegate.currentConfiguration.last;
    final RouteMatchList matchList = lastMatch is ImperativeRouteMatch
        ? lastMatch.matches
        : routerDelegate.currentConfiguration;
    return matchList.uri.toString();
  }
}
