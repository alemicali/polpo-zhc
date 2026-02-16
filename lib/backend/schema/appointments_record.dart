import 'dart:async';

import 'package:collection/collection.dart';

import '/backend/schema/util/firestore_util.dart';

import 'index.dart';
import '/flutter_flow/flutter_flow_util.dart';

class AppointmentsRecord extends FirestoreRecord {
  AppointmentsRecord._(
    DocumentReference reference,
    Map<String, dynamic> data,
  ) : super(reference, data) {
    _initializeFields();
  }

  // "workers" field.
  List<DocumentReference>? _workers;
  List<DocumentReference> get workers => _workers ?? const [];
  bool hasWorkers() => _workers != null;

  // "startDate" field.
  DateTime? _startDate;
  DateTime? get startDate => _startDate;
  bool hasStartDate() => _startDate != null;

  // "endDate" field.
  DateTime? _endDate;
  DateTime? get endDate => _endDate;
  bool hasEndDate() => _endDate != null;

  // "price" field.
  double? _price;
  double get price => _price ?? 0.0;
  bool hasPrice() => _price != null;

  // "duration" field.
  int? _duration;
  int get duration => _duration ?? 0;
  bool hasDuration() => _duration != null;

  // "client" field.
  DocumentReference? _client;
  DocumentReference? get client => _client;
  bool hasClient() => _client != null;

  // "email" field.
  String? _email;
  String get email => _email ?? '';
  bool hasEmail() => _email != null;

  // "clientData" field.
  ClientDataStruct? _clientData;
  ClientDataStruct get clientData => _clientData ?? ClientDataStruct();
  bool hasClientData() => _clientData != null;

  // "workersData" field.
  List<WorkerDataStruct>? _workersData;
  List<WorkerDataStruct> get workersData => _workersData ?? const [];
  bool hasWorkersData() => _workersData != null;

  // "serviceData" field.
  ServiceDataStruct? _serviceData;
  ServiceDataStruct get serviceData => _serviceData ?? ServiceDataStruct();
  bool hasServiceData() => _serviceData != null;

  // "canceled" field.
  bool? _canceled;
  bool get canceled => _canceled ?? false;
  bool hasCanceled() => _canceled != null;

  // "cancellationReason" field.
  String? _cancellationReason;
  String get cancellationReason => _cancellationReason ?? '';
  bool hasCancellationReason() => _cancellationReason != null;

  // "canceledBy" field.
  String? _canceledBy;
  String get canceledBy => _canceledBy ?? '';
  bool hasCanceledBy() => _canceledBy != null;

  // "accomodation" field.
  DocumentReference? _accomodation;
  DocumentReference? get accomodation => _accomodation;
  bool hasAccomodation() => _accomodation != null;

  // "isSecondAgenda" field.
  bool? _isSecondAgenda;
  bool get isSecondAgenda => _isSecondAgenda ?? false;
  bool hasIsSecondAgenda() => _isSecondAgenda != null;

  void _initializeFields() {
    _workers = getDataList(snapshotData['workers']);
    _startDate = snapshotData['startDate'] as DateTime?;
    _endDate = snapshotData['endDate'] as DateTime?;
    _price = castToType<double>(snapshotData['price']);
    _duration = castToType<int>(snapshotData['duration']);
    _client = snapshotData['client'] as DocumentReference?;
    _email = snapshotData['email'] as String?;
    _clientData = snapshotData['clientData'] is ClientDataStruct
        ? snapshotData['clientData']
        : ClientDataStruct.maybeFromMap(snapshotData['clientData']);
    _workersData = getStructList(
      snapshotData['workersData'],
      WorkerDataStruct.fromMap,
    );
    _serviceData = snapshotData['serviceData'] is ServiceDataStruct
        ? snapshotData['serviceData']
        : ServiceDataStruct.maybeFromMap(snapshotData['serviceData']);
    _canceled = snapshotData['canceled'] as bool?;
    _cancellationReason = snapshotData['cancellationReason'] as String?;
    _canceledBy = snapshotData['canceledBy'] as String?;
    _accomodation = snapshotData['accomodation'] as DocumentReference?;
    _isSecondAgenda = snapshotData['isSecondAgenda'] as bool?;
  }

  static CollectionReference get collection =>
      FirebaseFirestore.instance.collection('appointments');

  static Stream<AppointmentsRecord> getDocument(DocumentReference ref) =>
      ref.snapshots().map((s) => AppointmentsRecord.fromSnapshot(s));

  static Future<AppointmentsRecord> getDocumentOnce(DocumentReference ref) =>
      ref.get().then((s) => AppointmentsRecord.fromSnapshot(s));

  static AppointmentsRecord fromSnapshot(DocumentSnapshot snapshot) =>
      AppointmentsRecord._(
        snapshot.reference,
        mapFromFirestore(snapshot.data() as Map<String, dynamic>),
      );

  static AppointmentsRecord getDocumentFromData(
    Map<String, dynamic> data,
    DocumentReference reference,
  ) =>
      AppointmentsRecord._(reference, mapFromFirestore(data));

  @override
  String toString() =>
      'AppointmentsRecord(reference: ${reference.path}, data: $snapshotData)';

  @override
  int get hashCode => reference.path.hashCode;

  @override
  bool operator ==(other) =>
      other is AppointmentsRecord &&
      reference.path.hashCode == other.reference.path.hashCode;
}

Map<String, dynamic> createAppointmentsRecordData({
  DateTime? startDate,
  DateTime? endDate,
  double? price,
  int? duration,
  DocumentReference? client,
  String? email,
  ClientDataStruct? clientData,
  ServiceDataStruct? serviceData,
  bool? canceled,
  String? cancellationReason,
  String? canceledBy,
  DocumentReference? accomodation,
  bool? isSecondAgenda,
}) {
  final firestoreData = mapToFirestore(
    <String, dynamic>{
      'startDate': startDate,
      'endDate': endDate,
      'price': price,
      'duration': duration,
      'client': client,
      'email': email,
      'clientData': ClientDataStruct().toMap(),
      'serviceData': ServiceDataStruct().toMap(),
      'canceled': canceled,
      'cancellationReason': cancellationReason,
      'canceledBy': canceledBy,
      'accomodation': accomodation,
      'isSecondAgenda': isSecondAgenda,
    }.withoutNulls,
  );

  // Handle nested data for "clientData" field.
  addClientDataStructData(firestoreData, clientData, 'clientData');

  // Handle nested data for "serviceData" field.
  addServiceDataStructData(firestoreData, serviceData, 'serviceData');

  return firestoreData;
}

class AppointmentsRecordDocumentEquality
    implements Equality<AppointmentsRecord> {
  const AppointmentsRecordDocumentEquality();

  @override
  bool equals(AppointmentsRecord? e1, AppointmentsRecord? e2) {
    const listEquality = ListEquality();
    return listEquality.equals(e1?.workers, e2?.workers) &&
        e1?.startDate == e2?.startDate &&
        e1?.endDate == e2?.endDate &&
        e1?.price == e2?.price &&
        e1?.duration == e2?.duration &&
        e1?.client == e2?.client &&
        e1?.email == e2?.email &&
        e1?.clientData == e2?.clientData &&
        listEquality.equals(e1?.workersData, e2?.workersData) &&
        e1?.serviceData == e2?.serviceData &&
        e1?.canceled == e2?.canceled &&
        e1?.cancellationReason == e2?.cancellationReason &&
        e1?.canceledBy == e2?.canceledBy &&
        e1?.accomodation == e2?.accomodation &&
        e1?.isSecondAgenda == e2?.isSecondAgenda;
  }

  @override
  int hash(AppointmentsRecord? e) => const ListEquality().hash([
        e?.workers,
        e?.startDate,
        e?.endDate,
        e?.price,
        e?.duration,
        e?.client,
        e?.email,
        e?.clientData,
        e?.workersData,
        e?.serviceData,
        e?.canceled,
        e?.cancellationReason,
        e?.canceledBy,
        e?.accomodation,
        e?.isSecondAgenda
      ]);

  @override
  bool isValidKey(Object? o) => o is AppointmentsRecord;
}
